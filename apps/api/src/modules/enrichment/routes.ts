import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { hashContactValue } from '../contacts/crypto.ts';
import {
  ACTIVE_JOB_STATUSES as ACTIVE,
  dailyJobQuotaExceeded,
  isUniqueViolation,
  parseIdempotencyKey,
} from '../jobs/service.ts';
import { enqueueEvent } from '../outbox/service.ts';
import { insertJobSources } from '../research/routes.ts';
import { planSources } from '../sources/service.ts';
import { ENRICH_OPERATIONS, type EnrichmentWorkflowInput } from '../../temporal/types.ts';
import { enrichmentWorkflowId } from '../../temporal/dispatcher.ts';

const Accepted = z.object({ job_id: z.string(), status: z.string(), status_url: z.string() });

export const enrichmentRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, config } = deps;

    app.post(
      '/people/:id/enrich-jobs',
      {
        schema: {
          tags: ['enrichment'],
          params: z.object({ id: z.uuid() }),
          response: { 202: Accepted },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'enrich.start');
        const key = parseIdempotencyKey(request.headers['idempotency-key']);
        const personId = request.params.id;

        const create = () =>
          withContext(db, ctx, async (trx) => {
            const person = await trx
              .selectFrom('people as p')
              .innerJoin('person_company_links as l', 'l.person_id', 'p.id')
              .innerJoin('companies as c', 'c.id', 'l.company_id')
              .select([
                'p.id',
                'p.canonical_name',
                'p.merged_into_id',
                'c.id as company_id',
                'c.primary_domain',
                'c.canonical_name as company_name',
              ])
              .where('p.tenant_id', '=', ctx.tenantId)
              .where('p.id', '=', personId)
              .executeTakeFirst();
            if (!person || person.merged_into_id) throw notFound('Person');

            const blocked = await trx
              .selectFrom('consent_suppressions')
              .select('id')
              .where('tenant_id', '=', ctx.tenantId)
              .where((eb) =>
                eb.or([
                  eb.and([
                    eb('subject_type', '=', 'person'),
                    eb('value_hash', '=', hashContactValue('person', person.id)),
                  ]),
                  eb.and([
                    eb('subject_type', '=', 'domain'),
                    eb('value_hash', '=', hashContactValue('domain', person.primary_domain)),
                  ]),
                ]),
              )
              .executeTakeFirst();
            if (blocked) {
              throw new AppError(
                'SUPPRESSED',
                'This person or company domain is on the suppression list.',
              );
            }

            let reusable = trx
              .selectFrom('workflow_jobs')
              .select(['id', 'status'])
              .where('tenant_id', '=', ctx.tenantId)
              .where('person_id', '=', personId)
              .where('job_type', '=', 'person_enrichment');
            reusable = key
              ? reusable.where((eb) =>
                  eb.or([eb('idempotency_key', '=', key), eb('status', 'in', ACTIVE)]),
                )
              : reusable.where('status', 'in', ACTIVE);
            const existing = await reusable
              .orderBy('created_at', 'desc')
              .limit(1)
              .executeTakeFirst();
            if (existing) return existing;

            const quotaExceeded = await dailyJobQuotaExceeded(
              trx,
              ctx,
              config.TENANT_DAILY_ENRICH_LIMIT,
              { action: 'enrichment.quota_exceeded', type: 'person', id: personId },
              'person_enrichment',
            );
            if (quotaExceeded) return { quotaExceeded: true as const };

            const plan = await planSources(trx, ctx.tenantId, config, ENRICH_OPERATIONS, {
              maxEvidence: 2,
              maxRecords: 2,
            });
            if (plan.run.length === 0) return { noSources: true as const };

            const jobId = randomUUID();
            const input: EnrichmentWorkflowInput = {
              tenantId: ctx.tenantId,
              jobId,
              companyId: person.company_id,
              personId: person.id,
              personName: person.canonical_name,
              domain: person.primary_domain,
              companyName: person.company_name,
              correlationId: ctx.correlationId,
              pythonTaskQueue: config.RESEARCH_PYTHON_TASK_QUEUE,
              sources: plan.run,
              budget: { maxRecordsPerSource: 2, maxEvidencePerSource: 2 },
            };
            await trx
              .insertInto('workflow_jobs')
              .values({
                id: jobId,
                tenant_id: ctx.tenantId,
                company_id: person.company_id,
                person_id: person.id,
                job_type: 'person_enrichment',
                idempotency_key: key ?? `auto:${jobId}`,
                input: JSON.stringify(input),
                requested_by: ctx.userId,
                temporal_workflow_id: enrichmentWorkflowId(jobId),
              })
              .execute();
            await insertJobSources(trx, ctx.tenantId, jobId, plan);
            await enqueueEvent(trx, {
              tenantId: ctx.tenantId,
              eventType: 'enrichment.person.requested',
              correlationId: ctx.correlationId,
              idempotencyKey: jobId,
              payload: { job_id: jobId, person_id: person.id, workflow_input: input },
            });
            await recordAudit(trx, {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              action: 'enrichment.requested',
              entityType: 'enrich_job',
              entityId: jobId,
              correlationId: ctx.correlationId,
              metadata: { person_id: person.id, sources: input.sources.map((s) => s.sourceKey) },
            });
            return { id: jobId, status: 'queued' };
          });

        let result;
        try {
          result = await create();
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          result = await create();
        }
        if ('quotaExceeded' in result) {
          throw new AppError(
            'QUOTA_EXCEEDED',
            'Daily enrichment limit reached for this workspace.',
          );
        }
        if ('noSources' in result) {
          throw new AppError(
            'FEATURE_DISABLED',
            'No contact enrichment sources are available for this workspace.',
          );
        }
        return reply.status(202).send({
          job_id: result.id,
          status: result.status,
          status_url: `/api/v1/enrich-jobs/${result.id}`,
        });
      },
    );

    app.get(
      '/enrich-jobs/:id',
      {
        schema: {
          tags: ['enrichment'],
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              id: z.string(),
              person_id: z.string().nullable(),
              company_id: z.string().nullable(),
              status: z.string(),
              error_code: z.string().nullable(),
              error_summary: z.string().nullable(),
              sources: z.array(
                z.object({
                  source_key: z.string(),
                  status: z.string(),
                  error_code: z.string().nullable(),
                  error_summary: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.read');
        return withContext(db, ctx, async (trx) => {
          const job = await trx
            .selectFrom('workflow_jobs')
            .select(['id', 'person_id', 'company_id', 'status', 'error_code', 'error_summary'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .where('job_type', '=', 'person_enrichment')
            .executeTakeFirst();
          if (!job) throw notFound('Enrichment job');
          const sources = await trx
            .selectFrom('workflow_job_sources')
            .select(['source_key', 'status', 'error_code', 'error_summary'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('job_id', '=', job.id)
            .orderBy('source_key')
            .execute();
          return { ...job, sources };
        });
      },
    );
  };
