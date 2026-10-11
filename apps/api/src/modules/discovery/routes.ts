import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { withContext, type Tx } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { decodeCursor, PageMeta, PageQuery, paginate } from '../../http/pagination.ts';
import { discoveryWorkflowId } from '../../temporal/dispatcher.ts';
import { DISCOVERY_OPERATIONS, type DiscoveryWorkflowInput } from '../../temporal/types.ts';
import { recordAudit } from '../audit/service.ts';
import { resolveTenantLimits } from '../budgets/service.ts';
import { Company, toCompanyDto } from '../companies/routes.ts';
import {
  ACTIVE_JOB_STATUSES,
  dailyJobQuotaExceeded,
  isUniqueViolation,
  parseIdempotencyKey,
} from '../jobs/service.ts';
import { enqueueEvent } from '../outbox/service.ts';
import { insertJobSources } from '../research/routes.ts';
import { planSources } from '../sources/service.ts';

const MAX_ACTIVE_DISCOVERY_JOBS = 3;

const Query = z.object({
  text: z.string().trim().min(3).max(200),
  country_codes: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .max(32)
    .default([]),
});

const JobSource = z.object({
  source_key: z.string(),
  status: z.string(),
  attempts: z.number(),
  evidence_count: z.number(),
  error_code: z.string().nullable(),
  error_summary: z.string().nullable(),
  finished_at: z.string().nullable(),
});

const SearchSummary = z.object({
  id: z.string(),
  status: z.string(),
  query: Query,
  created_at: z.string(),
  finished_at: z.string().nullable(),
  candidate_count: z.number(),
});

const Candidate = z.object({
  id: z.string(),
  source_key: z.string(),
  name: z.string(),
  domain: z.string(),
  country_code: z.string().nullable(),
  description: z.string().nullable(),
  claim_type: z.enum(['source_fact', 'provider_fact']),
  confidence: z.number(),
  evidence_id: z.string(),
  evidence_url: z.string(),
  status: z.enum(['new', 'accepted', 'dismissed']),
  company_id: z.string().nullable(),
  existing_company_id: z.string().nullable(),
});

const Search = SearchSummary.extend({
  error_code: z.string().nullable(),
  error_summary: z.string().nullable(),
  sources: z.array(JobSource),
  candidates: z.array(Candidate),
});

const Accepted = z.object({ job_id: z.string(), status: z.string(), status_url: z.string() });

/** Idempotency is per workspace and query; the default key makes double-clicks converge. */
function defaultKey(query: z.infer<typeof Query>, userId: string): string {
  const day = new Date().toISOString().slice(0, 10);
  const digest = createHash('sha256')
    .update(
      JSON.stringify([query.text.toLowerCase(), [...query.country_codes].sort(), userId, day]),
    )
    .digest('hex')
    .slice(0, 40);
  return `auto:${digest}`;
}

async function loadSearch(trx: Tx, tenantId: string, id: string) {
  const job = await trx
    .selectFrom('workflow_jobs')
    .select([
      'id',
      'status',
      'query',
      'created_at',
      'finished_at',
      'error_code',
      'error_summary',
      'temporal_workflow_id',
    ])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .where('job_type', '=', 'company_discovery')
    .executeTakeFirst();
  if (!job) throw notFound('Discovery search');
  return job;
}

async function loadCandidates(trx: Tx, tenantId: string, jobId: string) {
  const rows = await trx
    .selectFrom('discovery_candidates as c')
    .innerJoin('evidence_records as e', 'e.id', 'c.evidence_record_id')
    .leftJoin('companies as co', (join) =>
      join.onRef('co.primary_domain', '=', 'c.domain').on('co.tenant_id', '=', tenantId),
    )
    .select([
      'c.id',
      'c.source_key',
      'c.name',
      'c.domain',
      'c.country_code',
      'c.description',
      'c.claim_type',
      'c.confidence',
      'c.evidence_record_id as evidence_id',
      'e.source_url as evidence_url',
      'c.status',
      'c.company_id',
      'co.id as existing_company_id',
    ])
    .where('c.tenant_id', '=', tenantId)
    .where('c.job_id', '=', jobId)
    .orderBy('c.confidence', 'desc')
    .orderBy('c.domain')
    .limit(500)
    .execute();
  return rows.map((r) => ({ ...r, confidence: Number(r.confidence) }));
}

export const discoveryRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, config, dispatcher } = deps;

    app.post(
      '/discovery-searches',
      {
        schema: {
          tags: ['discovery'],
          body: Query.strict(),
          response: { 202: Accepted },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'discovery.start');
        const query = request.body;
        const key =
          parseIdempotencyKey(request.headers['idempotency-key']) ?? defaultKey(query, ctx.userId);

        const create = () =>
          withContext(db, ctx, async (trx) => {
            const existing = await trx
              .selectFrom('workflow_jobs')
              .select(['id', 'status'])
              .where('tenant_id', '=', ctx.tenantId)
              .where('job_type', '=', 'company_discovery')
              .where('idempotency_key', '=', key)
              .executeTakeFirst();
            if (existing) return existing;

            const active = await trx
              .selectFrom('workflow_jobs')
              .select((eb) => eb.fn.countAll<string>().as('n'))
              .where('tenant_id', '=', ctx.tenantId)
              .where('job_type', '=', 'company_discovery')
              .where('status', 'in', ACTIVE_JOB_STATUSES)
              .executeTakeFirstOrThrow();
            if (Number(active.n) >= MAX_ACTIVE_DISCOVERY_JOBS) return { tooMany: true as const };

            if (
              await dailyJobQuotaExceeded(
                trx,
                ctx,
                (await resolveTenantLimits(trx, ctx.tenantId, config)).research,
                {
                  action: 'discovery.quota_exceeded',
                  type: 'discovery_job',
                  id: null,
                },
              )
            ) {
              return { quotaExceeded: true as const };
            }
            const plan = await planSources(trx, ctx.tenantId, config, DISCOVERY_OPERATIONS, {
              maxEvidence: 5,
              maxRecords: 25,
            });
            if (plan.run.length === 0) return { noSources: true as const };

            const jobId = randomUUID();
            const input: DiscoveryWorkflowInput = {
              tenantId: ctx.tenantId,
              jobId,
              correlationId: ctx.correlationId,
              pythonTaskQueue: config.RESEARCH_PYTHON_TASK_QUEUE,
              query,
              sources: plan.run,
              budget: { maxRecordsPerSource: 25, maxEvidencePerSource: 5 },
            };
            await trx
              .insertInto('workflow_jobs')
              .values({
                id: jobId,
                tenant_id: ctx.tenantId,
                company_id: null,
                job_type: 'company_discovery',
                query: JSON.stringify(query),
                idempotency_key: key,
                input: JSON.stringify(input),
                requested_by: ctx.userId,
                temporal_workflow_id: discoveryWorkflowId(jobId),
              })
              .execute();
            await insertJobSources(trx, ctx.tenantId, jobId, plan);
            await enqueueEvent(trx, {
              tenantId: ctx.tenantId,
              eventType: 'discovery.search.requested',
              correlationId: ctx.correlationId,
              idempotencyKey: jobId,
              payload: { job_id: jobId, workflow_input: input },
            });
            await recordAudit(trx, {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              action: 'discovery.requested',
              entityType: 'discovery_job',
              entityId: jobId,
              correlationId: ctx.correlationId,
              metadata: {
                query_length: query.text.length,
                country_codes: query.country_codes,
                sources: plan.run.map((s) => s.sourceKey),
              },
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
        if ('tooMany' in result) {
          throw new AppError(
            'QUOTA_EXCEEDED',
            `At most ${MAX_ACTIVE_DISCOVERY_JOBS} discovery searches can run at once.`,
          );
        }
        if ('quotaExceeded' in result) {
          throw new AppError('QUOTA_EXCEEDED', 'Daily job limit reached for this workspace.');
        }
        if ('noSources' in result) {
          throw new AppError(
            'FEATURE_DISABLED',
            'No discovery sources are available for this workspace.',
          );
        }
        return reply.status(202).send({
          job_id: result.id,
          status: result.status,
          status_url: `/api/v1/discovery-searches/${result.id}`,
        });
      },
    );

    app.get(
      '/discovery-searches',
      {
        schema: {
          tags: ['discovery'],
          querystring: PageQuery,
          response: { 200: z.object({ data: z.array(SearchSummary), ...PageMeta }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        const { limit } = request.query;
        const cursor = decodeCursor(request.query.cursor);
        const rows = await withContext(db, ctx, (trx) => {
          let q = trx
            .selectFrom('workflow_jobs as j')
            .select((eb) => [
              'j.id',
              'j.status',
              'j.query',
              'j.created_at',
              'j.finished_at',
              eb
                .selectFrom('discovery_candidates as c')
                .select((e) => e.fn.countAll<string>().as('n'))
                .whereRef('c.job_id', '=', 'j.id')
                .as('candidate_count'),
            ])
            .where('j.tenant_id', '=', ctx.tenantId)
            .where('j.job_type', '=', 'company_discovery');
          if (cursor) {
            q = q.where((eb) =>
              eb.or([
                eb('j.created_at', '<', new Date(cursor.t)),
                eb.and([eb('j.created_at', '=', new Date(cursor.t)), eb('j.id', '<', cursor.id)]),
              ]),
            );
          }
          return q
            .orderBy('j.created_at', 'desc')
            .orderBy('j.id', 'desc')
            .limit(limit + 1)
            .execute();
        });
        const { page, ...meta } = paginate(rows, limit);
        return {
          data: page.map((r) => ({
            id: r.id,
            status: r.status,
            query: Query.parse(r.query),
            created_at: r.created_at.toISOString(),
            finished_at: r.finished_at?.toISOString() ?? null,
            candidate_count: Number(r.candidate_count ?? 0),
          })),
          ...meta,
        };
      },
    );

    app.get(
      '/discovery-searches/:id',
      {
        schema: {
          tags: ['discovery'],
          params: z.object({ id: z.uuid() }),
          response: { 200: Search },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        return withContext(db, ctx, async (trx) => {
          const job = await loadSearch(trx, ctx.tenantId, request.params.id);
          const sources = await trx
            .selectFrom('workflow_job_sources')
            .select([
              'source_key',
              'status',
              'attempts',
              'evidence_count',
              'error_code',
              'error_summary',
              'finished_at',
            ])
            .where('tenant_id', '=', ctx.tenantId)
            .where('job_id', '=', job.id)
            .orderBy('source_key')
            .execute();
          const candidates = await loadCandidates(trx, ctx.tenantId, job.id);
          return {
            id: job.id,
            status: job.status,
            query: Query.parse(job.query),
            created_at: job.created_at.toISOString(),
            finished_at: job.finished_at?.toISOString() ?? null,
            error_code: job.error_code,
            error_summary: job.error_summary,
            candidate_count: candidates.length,
            sources: sources.map((s) => ({
              ...s,
              finished_at: s.finished_at?.toISOString() ?? null,
            })),
            candidates,
          };
        });
      },
    );

    app.post(
      '/discovery-searches/:id/cancel',
      {
        schema: {
          tags: ['discovery'],
          params: z.object({ id: z.uuid() }),
          response: { 202: Accepted },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'research.cancel');
        const job = await withContext(db, ctx, async (trx) => {
          const current = await loadSearch(trx, ctx.tenantId, request.params.id);
          if (current.status === 'cancel_requested') return current;
          if (current.status !== 'queued' && current.status !== 'running') {
            throw new AppError('INVALID_STATE', `Search is already ${current.status}.`);
          }
          await trx
            .updateTable('workflow_jobs')
            .set((eb) => ({ status: 'cancel_requested', version: eb('version', '+', 1) }))
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', current.id)
            .execute();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'discovery.cancel_requested',
            entityType: 'discovery_job',
            entityId: current.id,
            correlationId: ctx.correlationId,
          });
          return current;
        });
        await dispatcher.cancel(job.temporal_workflow_id);
        return reply.status(202).send({
          job_id: job.id,
          status: 'cancel_requested',
          status_url: `/api/v1/discovery-searches/${job.id}`,
        });
      },
    );

    app.post(
      '/discovery-candidates/:id/accept',
      {
        schema: {
          tags: ['discovery'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ created: z.boolean(), company: Company }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.write');
        return withContext(db, ctx, async (trx) => {
          const c = await trx
            .selectFrom('discovery_candidates')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!c) throw notFound('Candidate');
          if (c.status === 'dismissed') {
            throw new AppError('INVALID_STATE', 'Candidate was dismissed.');
          }

          const inserted = await trx
            .insertInto('companies')
            .values({
              tenant_id: ctx.tenantId,
              canonical_name: c.name,
              primary_domain: c.domain,
              country_code: c.country_code,
              description: c.description,
              created_by: ctx.userId,
            })
            .onConflict((oc) => oc.columns(['tenant_id', 'primary_domain']).doNothing())
            .returningAll()
            .executeTakeFirst();
          const company =
            inserted ??
            (await trx
              .selectFrom('companies')
              .selectAll()
              .where('tenant_id', '=', ctx.tenantId)
              .where('primary_domain', '=', c.domain)
              .executeTakeFirstOrThrow());

          if (inserted) {
            // The fields copied from the candidate keep their provider provenance as claims.
            const claims = [
              ['canonical_name', c.name],
              ['country_code', c.country_code],
              ['description', c.description],
            ] as const;
            for (const [predicate, value] of claims) {
              if (!value) continue;
              const claim = await trx
                .insertInto('claims')
                .values({
                  tenant_id: ctx.tenantId,
                  subject_type: 'company',
                  subject_id: company.id,
                  predicate,
                  object_value: JSON.stringify(value),
                  claim_type: c.claim_type,
                  confidence: c.confidence,
                  source_key: c.source_key,
                  workflow_job_id: c.job_id,
                  observed_at: c.created_at,
                })
                .returning('id')
                .executeTakeFirstOrThrow();
              await trx
                .insertInto('claim_evidence')
                .values({
                  claim_id: claim.id,
                  evidence_record_id: c.evidence_record_id,
                  tenant_id: ctx.tenantId,
                })
                .execute();
            }
          }
          await trx
            .updateTable('discovery_candidates')
            .set({
              status: 'accepted',
              company_id: company.id,
              decided_by: ctx.userId,
              decided_at: new Date(),
            })
            .where('id', '=', c.id)
            .execute();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'discovery.candidate_accepted',
            entityType: 'company',
            entityId: company.id,
            correlationId: ctx.correlationId,
            metadata: { candidate_id: c.id, created: Boolean(inserted), domain: c.domain },
          });
          return { created: Boolean(inserted), company: toCompanyDto(company) };
        });
      },
    );

    app.post(
      '/discovery-candidates/:id/dismiss',
      {
        schema: {
          tags: ['discovery'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ id: z.string(), status: z.literal('dismissed') }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.write');
        return withContext(db, ctx, async (trx) => {
          const updated = await trx
            .updateTable('discovery_candidates')
            .set({ status: 'dismissed', decided_by: ctx.userId, decided_at: new Date() })
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .where('status', '=', 'new')
            .returning('id')
            .executeTakeFirst();
          if (!updated) {
            const exists = await trx
              .selectFrom('discovery_candidates')
              .select('status')
              .where('tenant_id', '=', ctx.tenantId)
              .where('id', '=', request.params.id)
              .executeTakeFirst();
            if (!exists) throw notFound('Candidate');
            if (exists.status !== 'dismissed') {
              throw new AppError('INVALID_STATE', `Candidate is already ${exists.status}.`);
            }
          }
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'discovery.candidate_dismissed',
            entityType: 'discovery_candidate',
            entityId: request.params.id,
            correlationId: ctx.correlationId,
          });
          return { id: request.params.id, status: 'dismissed' as const };
        });
      },
    );
  };
