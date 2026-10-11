import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withContext, type Tx } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant, type TenantCtx } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { resolveTenantLimits } from '../budgets/service.ts';
import { loadCompany } from '../companies/routes.ts';
import {
  ACTIVE_JOB_STATUSES as ACTIVE,
  dailyJobQuotaExceeded,
  isUniqueViolation,
  parseIdempotencyKey,
} from '../jobs/service.ts';
import { enqueueEvent } from '../outbox/service.ts';
import { planSources, type PlannedSources } from '../sources/service.ts';
import { RESEARCH_OPERATIONS, type ResearchWorkflowInput } from '../../temporal/types.ts';
import { researchWorkflowId } from '../../temporal/dispatcher.ts';

/** Planned sources start `pending`; budget-skipped ones are recorded so users see why. */
export async function insertJobSources(
  trx: Tx,
  tenantId: string,
  jobId: string,
  plan: PlannedSources,
) {
  await trx
    .insertInto('workflow_job_sources')
    .values([
      ...plan.run.map((s) => ({ job_id: jobId, tenant_id: tenantId, source_key: s.sourceKey })),
      ...plan.skipped.map((s) => ({
        job_id: jobId,
        tenant_id: tenantId,
        source_key: s.sourceKey,
        status: 'skipped' as const,
        error_code: s.errorCode,
        error_summary: s.errorSummary,
        finished_at: new Date(),
      })),
    ])
    .execute();
}

const Job = z.object({
  id: z.string(),
  company_id: z.string(),
  status: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  error_code: z.string().nullable(),
  error_summary: z.string().nullable(),
  sources: z.array(
    z.object({
      source_key: z.string(),
      status: z.string(),
      attempts: z.number(),
      evidence_count: z.number(),
      error_code: z.string().nullable(),
      error_summary: z.string().nullable(),
      finished_at: z.string().nullable(),
    }),
  ),
});

const Accepted = z.object({ job_id: z.string(), status: z.string(), status_url: z.string() });

const accepted = (id: string, status: string) => ({
  job_id: id,
  status,
  status_url: `/api/v1/research-jobs/${id}`,
});

async function loadJob(trx: Tx, tenantId: string, id: string) {
  const job = await trx
    .selectFrom('workflow_jobs')
    .select([
      'id',
      'company_id',
      'status',
      'created_at',
      'started_at',
      'finished_at',
      'error_code',
      'error_summary',
      'temporal_workflow_id',
    ])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .where('job_type', '=', 'company_research')
    .executeTakeFirst();
  if (!job || !job.company_id) throw notFound('Research job');
  return { ...job, company_id: job.company_id };
}

export const researchRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, config, dispatcher } = deps;

    async function findReusableJob(trx: Tx, ctx: TenantCtx, companyId: string, key: string | null) {
      let q = trx
        .selectFrom('workflow_jobs')
        .select(['id', 'status'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('company_id', '=', companyId)
        .where('job_type', '=', 'company_research');
      q = key
        ? q.where((eb) => eb.or([eb('idempotency_key', '=', key), eb('status', 'in', ACTIVE)]))
        : q.where('status', 'in', ACTIVE);
      return q.orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    }

    app.post(
      '/companies/:id/research-jobs',
      {
        schema: {
          tags: ['research'],
          params: z.object({ id: z.uuid() }),
          response: { 202: Accepted },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'research.start');
        const key = parseIdempotencyKey(request.headers['idempotency-key']);
        const companyId = request.params.id;

        const create = () =>
          withContext(db, ctx, async (trx) => {
            const company = await loadCompany(trx, ctx.tenantId, companyId);
            const reusable = await findReusableJob(trx, ctx, companyId, key);
            if (reusable) return reusable;

            const limits = await resolveTenantLimits(trx, ctx.tenantId, config);
            const quotaExceeded = await dailyJobQuotaExceeded(trx, ctx, limits.research, {
              action: 'research.quota_exceeded',
              type: 'company',
              id: companyId,
            });
            if (quotaExceeded) return { quotaExceeded: true as const };

            const plan = await planSources(trx, ctx.tenantId, config, RESEARCH_OPERATIONS, {
              maxEvidence: 10,
              maxRecords: 25,
            });
            if (plan.run.length === 0) return { noSources: true as const };

            const jobId = randomUUID();
            const input: ResearchWorkflowInput = {
              tenantId: ctx.tenantId,
              jobId,
              companyId,
              domain: company.primary_domain,
              companyName: company.canonical_name as string,
              correlationId: ctx.correlationId,
              pythonTaskQueue: config.RESEARCH_PYTHON_TASK_QUEUE,
              sources: plan.run,
              budget: { maxRecordsPerSource: 25, maxEvidencePerSource: 10 },
            };
            await trx
              .insertInto('workflow_jobs')
              .values({
                id: jobId,
                tenant_id: ctx.tenantId,
                company_id: companyId,
                job_type: 'company_research',
                idempotency_key: key ?? `auto:${jobId}`,
                input: JSON.stringify(input),
                requested_by: ctx.userId,
                temporal_workflow_id: researchWorkflowId(jobId),
              })
              .execute();
            await insertJobSources(trx, ctx.tenantId, jobId, plan);
            await enqueueEvent(trx, {
              tenantId: ctx.tenantId,
              eventType: 'research.company.requested',
              correlationId: ctx.correlationId,
              idempotencyKey: jobId,
              payload: { job_id: jobId, company_id: companyId, workflow_input: input },
            });
            await recordAudit(trx, {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              action: 'research.requested',
              entityType: 'research_job',
              entityId: jobId,
              correlationId: ctx.correlationId,
              metadata: {
                company_id: companyId,
                sources: input.sources.map((s) => s.sourceKey),
                skipped: plan.skipped.map((s) => s.sourceKey),
              },
            });
            return { id: jobId, status: 'queued' };
          });

        let result;
        try {
          result = await create();
        } catch (err) {
          // A concurrent submit won the race for the single active job; converge on it.
          if (!isUniqueViolation(err)) throw err;
          result = await create();
        }
        if ('quotaExceeded' in result) {
          throw new AppError(
            'QUOTA_EXCEEDED',
            'Daily research job limit reached for this workspace.',
          );
        }
        if ('noSources' in result) {
          throw new AppError(
            'FEATURE_DISABLED',
            'No research sources are available for this workspace.',
          );
        }
        return reply.status(202).send(accepted(result.id, result.status));
      },
    );

    app.get(
      '/research-jobs/:id',
      {
        schema: {
          tags: ['research'],
          params: z.object({ id: z.uuid() }),
          response: { 200: Job },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        return withContext(db, ctx, async (trx) => {
          const job = await loadJob(trx, ctx.tenantId, request.params.id);
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
          return {
            id: job.id,
            company_id: job.company_id,
            status: job.status,
            created_at: job.created_at.toISOString(),
            started_at: job.started_at?.toISOString() ?? null,
            finished_at: job.finished_at?.toISOString() ?? null,
            error_code: job.error_code,
            error_summary: job.error_summary,
            sources: sources.map((s) => ({
              ...s,
              finished_at: s.finished_at?.toISOString() ?? null,
            })),
          };
        });
      },
    );

    app.post(
      '/research-jobs/:id/cancel',
      {
        schema: {
          tags: ['research'],
          params: z.object({ id: z.uuid() }),
          response: { 202: Accepted },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'research.cancel');
        const job = await withContext(db, ctx, async (trx) => {
          const current = await loadJob(trx, ctx.tenantId, request.params.id);
          if (current.status === 'cancel_requested') return current;
          if (current.status !== 'queued' && current.status !== 'running') {
            throw new AppError('INVALID_STATE', `Job is already ${current.status}.`);
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
            action: 'research.cancel_requested',
            entityType: 'research_job',
            entityId: current.id,
            correlationId: ctx.correlationId,
          });
          return current;
        });
        await dispatcher.cancel(job.temporal_workflow_id);
        return reply.status(202).send(accepted(job.id, 'cancel_requested'));
      },
    );
  };
