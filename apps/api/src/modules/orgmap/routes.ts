import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { validateOrgMapV2, type OrgMapV2 } from '@mapforce/contracts';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { applyOverlay, gatherOrgMapRequest } from '../ai/gather.ts';
import { persistAiRun } from '../ai/persist.ts';
import { deduceOrgMap, selectProvider } from '../ai/service.ts';
import { recordAudit } from '../audit/service.ts';
import { loadCompany } from '../companies/routes.ts';
import {
  ACTIVE_JOB_STATUSES as ACTIVE,
  dailyJobQuotaExceeded,
  isUniqueViolation,
  parseIdempotencyKey,
} from '../jobs/service.ts';
import { enqueueEvent } from '../outbox/service.ts';

const Accepted = z.object({ job_id: z.string(), status: z.string(), status_url: z.string() });

async function latestOverlay(
  trx: Parameters<typeof gatherOrgMapRequest>[0],
  tenantId: string,
  companyId: string,
) {
  return trx
    .selectFrom('ai_runs')
    .select(['id', 'result', 'provider', 'validation_outcome', 'status', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .where('company_id', '=', companyId)
    .where('status', 'in', ['succeeded', 'quarantined'])
    .where('result', 'is not', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
}

export const orgMapRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, config } = deps;

    app.get(
      '/companies/:id/org-map',
      {
        schema: {
          tags: ['org-map'],
          description: 'Organization map conforming to contracts/org-map.v2.schema.json.',
          params: z.object({ id: z.uuid() }),
          response: { 200: z.record(z.string(), z.unknown()) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.read');
        const map = await withContext(db, ctx, async (trx): Promise<OrgMapV2> => {
          const { sourced } = await gatherOrgMapRequest(trx, ctx.tenantId, request.params.id);
          const overlay = await latestOverlay(trx, ctx.tenantId, request.params.id);
          if (!overlay?.result) return sourced;
          const parsed = validateOrgMapV2(overlay.result);
          return parsed.ok ? applyOverlay(sourced, parsed.value) : sourced;
        });

        const check = validateOrgMapV2(map);
        if (!check.ok) {
          request.log.error({ errors: check.errors }, 'org map failed contract validation');
          throw new AppError('INTERNAL_ERROR', 'Organization map could not be produced.');
        }
        return map as unknown as Record<string, unknown>;
      },
    );

    app.post(
      '/companies/:id/org-map-jobs',
      {
        schema: {
          tags: ['org-map'],
          description:
            'Run evidence-grounded organization mapping. Uses the mock model unless Hermes is enabled.',
          params: z.object({ id: z.uuid() }),
          response: { 202: Accepted },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'orgmap.run');
        const key = parseIdempotencyKey(request.headers['idempotency-key']);
        const companyId = request.params.id;

        const create = () =>
          withContext(db, ctx, async (trx) => {
            await loadCompany(trx, ctx.tenantId, companyId);
            let reusable = trx
              .selectFrom('workflow_jobs')
              .select(['id', 'status'])
              .where('tenant_id', '=', ctx.tenantId)
              .where('company_id', '=', companyId)
              .where('job_type', '=', 'company_orgmap');
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
              config.TENANT_DAILY_AI_RUN_LIMIT,
              { action: 'orgmap.quota_exceeded', type: 'company', id: companyId },
              'company_orgmap',
            );
            if (quotaExceeded) return { quotaExceeded: true as const };

            const jobId = randomUUID();
            const now = new Date();
            await trx
              .insertInto('workflow_jobs')
              .values({
                id: jobId,
                tenant_id: ctx.tenantId,
                company_id: companyId,
                job_type: 'company_orgmap',
                idempotency_key: key ?? `auto:${jobId}`,
                input: JSON.stringify({ company_id: companyId }),
                requested_by: ctx.userId,
                temporal_workflow_id: `orgmap:${jobId}`,
                status: 'running',
                started_at: now,
              })
              .execute();

            const { request: packed } = await gatherOrgMapRequest(trx, ctx.tenantId, companyId);
            const deduced = await deduceOrgMap(packed, selectProvider(config), {
              maxTokens: config.AI_MAX_TOKENS,
              timeoutMs: config.AI_TIMEOUT_MS,
            });
            const runId = await persistAiRun(trx, {
              tenantId: ctx.tenantId,
              companyId,
              jobId,
              result: deduced,
            });
            const terminal = deduced.status === 'quarantined' ? 'partial_success' : 'succeeded';
            await trx
              .updateTable('workflow_jobs')
              .set({
                status: terminal,
                finished_at: new Date(),
                result: JSON.stringify({ ai_run_id: runId, provider: deduced.provider }),
                error_code: deduced.quarantine?.reason ?? null,
                error_summary: deduced.quarantine?.errors[0] ?? null,
              })
              .where('id', '=', jobId)
              .execute();
            await enqueueEvent(trx, {
              tenantId: ctx.tenantId,
              eventType: 'orgmap.inference.completed',
              correlationId: ctx.correlationId,
              idempotencyKey: jobId,
              payload: { job_id: jobId, company_id: companyId, ai_run_id: runId },
            });
            await recordAudit(trx, {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              action: 'orgmap.requested',
              entityType: 'orgmap_job',
              entityId: jobId,
              correlationId: ctx.correlationId,
              metadata: {
                company_id: companyId,
                provider: deduced.provider,
                validation: deduced.validation,
              },
            });
            return { id: jobId, status: terminal };
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
            'Daily organization-mapping limit reached for this workspace.',
          );
        }
        return reply.status(202).send({
          job_id: result.id,
          status: result.status,
          status_url: `/api/v1/org-map-jobs/${result.id}`,
        });
      },
    );

    app.get(
      '/org-map-jobs/:id',
      {
        schema: {
          tags: ['org-map'],
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              id: z.string(),
              company_id: z.string().nullable(),
              status: z.string(),
              error_code: z.string().nullable(),
              error_summary: z.string().nullable(),
              ai_run: z
                .object({
                  id: z.string(),
                  provider: z.string(),
                  model: z.string(),
                  validation_outcome: z.string(),
                  status: z.string(),
                  token_count: z.number(),
                  duration_ms: z.number(),
                })
                .nullable(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.read');
        return withContext(db, ctx, async (trx) => {
          const job = await trx
            .selectFrom('workflow_jobs')
            .select(['id', 'company_id', 'status', 'error_code', 'error_summary'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .where('job_type', '=', 'company_orgmap')
            .executeTakeFirst();
          if (!job) throw new AppError('NOT_FOUND', 'Organization-mapping job not found.');
          const run = await trx
            .selectFrom('ai_runs')
            .select([
              'id',
              'provider',
              'model',
              'validation_outcome',
              'status',
              'token_count',
              'duration_ms',
            ])
            .where('tenant_id', '=', ctx.tenantId)
            .where('workflow_job_id', '=', job.id)
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst();
          return {
            id: job.id,
            company_id: job.company_id,
            status: job.status,
            error_code: job.error_code,
            error_summary: job.error_summary,
            ai_run: run ?? null,
          };
        });
      },
    );

    app.get(
      '/companies/:id/outreach-drafts',
      {
        schema: {
          tags: ['org-map'],
          description: 'Human-review outreach drafts. Nothing is sent automatically.',
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              data: z.array(
                z.object({
                  id: z.string(),
                  person_id: z.string(),
                  display_name: z.string(),
                  body: z.string(),
                  claim_type: z.literal('model_inference'),
                  confidence: z.number(),
                  evidence_ids: z.array(z.string()),
                  rationale: z.string(),
                  status: z.string(),
                  created_at: z.string(),
                }),
              ),
              note: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.read');
        return withContext(db, ctx, async (trx) => {
          await loadCompany(trx, ctx.tenantId, request.params.id);
          const rows = await trx
            .selectFrom('outreach_drafts as d')
            .innerJoin('people as p', 'p.id', 'd.person_id')
            .select([
              'd.id',
              'd.person_id',
              'p.canonical_name',
              'd.body',
              'd.claim_type',
              'd.confidence',
              'd.evidence_ids',
              'd.rationale',
              'd.status',
              'd.created_at',
            ])
            .where('d.tenant_id', '=', ctx.tenantId)
            .where('d.company_id', '=', request.params.id)
            .orderBy('d.created_at', 'desc')
            .limit(100)
            .execute();
          return {
            data: rows.map((r) => ({
              id: r.id,
              person_id: r.person_id,
              display_name: r.canonical_name,
              body: r.body,
              claim_type: 'model_inference' as const,
              confidence: Number(r.confidence),
              evidence_ids: r.evidence_ids,
              rationale: r.rationale,
              status: r.status,
              created_at: r.created_at.toISOString(),
            })),
            note: 'Drafts are for human review. The product never sends outreach automatically.',
          };
        });
      },
    );
  };
