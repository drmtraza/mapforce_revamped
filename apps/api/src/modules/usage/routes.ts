import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { resolveTenantLimits } from '../budgets/service.ts';

const Usage = z.object({
  window_hours: z.number(),
  jobs: z.object({
    company_research: z.number(),
    company_discovery: z.number(),
    person_enrichment: z.number(),
    company_orgmap: z.number(),
  }),
  exports: z.number(),
  ai_tokens: z.number(),
  provider_rows: z.number(),
  limits: z.object({
    research: z.number(),
    enrich: z.number(),
    ai: z.number(),
    export: z.number(),
    provider_cost: z.number(),
    concurrent_jobs: z.number(),
    plan_id: z.string(),
  }),
  note: z.string(),
});

const EffectiveLimits = z.object({
  research: z.number(),
  enrich: z.number(),
  ai: z.number(),
  export: z.number(),
  provider_cost: z.number(),
  concurrent_jobs: z.number(),
  plan_id: z.string(),
});

const Budget = z.object({
  daily_research_job_limit: z.number().nullable(),
  daily_enrich_limit: z.number().nullable(),
  daily_ai_run_limit: z.number().nullable(),
  daily_export_limit: z.number().nullable(),
  daily_provider_cost_ceiling: z.number().nullable(),
  effective: EffectiveLimits,
});

export const usageRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, config } = deps;

    app.get(
      '/usage',
      {
        schema: { tags: ['usage'], response: { 200: Usage } },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'usage.read');
        return withContext(db, ctx, async (trx) => {
          const since = new Date(Date.now() - 86_400_000);
          const jobs = await trx
            .selectFrom('workflow_jobs')
            .select(['job_type', (eb) => eb.fn.countAll<string>().as('n')])
            .where('tenant_id', '=', ctx.tenantId)
            .where('created_at', '>=', since)
            .groupBy('job_type')
            .execute();
          const byType = Object.fromEntries(jobs.map((j) => [j.job_type, Number(j.n)]));
          const exports = await trx
            .selectFrom('export_batches')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('tenant_id', '=', ctx.tenantId)
            .where('created_at', '>=', since)
            .executeTakeFirstOrThrow();
          const tokenRows = await trx
            .selectFrom('ai_runs')
            .select('token_count')
            .where('tenant_id', '=', ctx.tenantId)
            .where('created_at', '>=', since)
            .execute();
          const tokenSum = tokenRows.reduce((n, r) => n + Number(r.token_count), 0);
          const providers = await trx
            .selectFrom('provider_usage')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('tenant_id', '=', ctx.tenantId)
            .where('occurred_at', '>=', since)
            .executeTakeFirstOrThrow();
          const limits = await resolveTenantLimits(trx, ctx.tenantId, config);
          return {
            window_hours: 24,
            jobs: {
              company_research: byType.company_research ?? 0,
              company_discovery: byType.company_discovery ?? 0,
              person_enrichment: byType.person_enrichment ?? 0,
              company_orgmap: byType.company_orgmap ?? 0,
            },
            exports: Number(exports.n),
            ai_tokens: tokenSum,
            provider_rows: Number(providers.n),
            limits,
            note: 'Usage is auditable workspace activity for the last 24 hours. Billing integration is not enabled.',
          };
        });
      },
    );

    app.get(
      '/workspace-budget',
      {
        schema: { tags: ['usage'], response: { 200: Budget } },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'usage.read');
        return withContext(db, ctx, async (trx) => {
          const row = await trx
            .selectFrom('tenant_budgets')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .executeTakeFirst();
          const effective = await resolveTenantLimits(trx, ctx.tenantId, config);
          return {
            daily_research_job_limit: row?.daily_research_job_limit ?? null,
            daily_enrich_limit: row?.daily_enrich_limit ?? null,
            daily_ai_run_limit: row?.daily_ai_run_limit ?? null,
            daily_export_limit: row?.daily_export_limit ?? null,
            daily_provider_cost_ceiling:
              row?.daily_provider_cost_ceiling != null
                ? Number(row.daily_provider_cost_ceiling)
                : null,
            effective,
          };
        });
      },
    );

    app.patch(
      '/workspace-budget',
      {
        schema: {
          tags: ['usage'],
          description:
            'Prefer POST /workspace-budget/ramp for gradual increases with plan ceilings.',
          body: z.object({
            daily_research_job_limit: z.number().int().min(0).max(100_000).nullable().optional(),
            daily_enrich_limit: z.number().int().min(0).max(100_000).nullable().optional(),
            daily_ai_run_limit: z.number().int().min(0).max(100_000).nullable().optional(),
            daily_export_limit: z.number().int().min(0).max(100_000).nullable().optional(),
            daily_provider_cost_ceiling: z.number().min(0).max(1_000_000).nullable().optional(),
          }),
          response: { 200: Budget },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'budget.manage');
        return withContext(db, ctx, async (trx) => {
          const current = await trx
            .selectFrom('tenant_budgets')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .executeTakeFirst();
          const next = {
            daily_research_job_limit:
              request.body.daily_research_job_limit === undefined
                ? (current?.daily_research_job_limit ?? null)
                : request.body.daily_research_job_limit,
            daily_enrich_limit:
              request.body.daily_enrich_limit === undefined
                ? (current?.daily_enrich_limit ?? null)
                : request.body.daily_enrich_limit,
            daily_ai_run_limit:
              request.body.daily_ai_run_limit === undefined
                ? (current?.daily_ai_run_limit ?? null)
                : request.body.daily_ai_run_limit,
            daily_export_limit:
              request.body.daily_export_limit === undefined
                ? (current?.daily_export_limit ?? null)
                : request.body.daily_export_limit,
            daily_provider_cost_ceiling:
              request.body.daily_provider_cost_ceiling === undefined
                ? (current?.daily_provider_cost_ceiling ?? null)
                : request.body.daily_provider_cost_ceiling,
            updated_by: ctx.userId,
          };
          await trx
            .insertInto('tenant_budgets')
            .values({ tenant_id: ctx.tenantId, ...next })
            .onConflict((oc) => oc.column('tenant_id').doUpdateSet(next))
            .execute();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'budget.updated',
            entityType: 'tenant_budget',
            entityId: ctx.tenantId,
            correlationId: ctx.correlationId,
          });
          const effective = await resolveTenantLimits(trx, ctx.tenantId, config);
          return {
            daily_research_job_limit: next.daily_research_job_limit,
            daily_enrich_limit: next.daily_enrich_limit,
            daily_ai_run_limit: next.daily_ai_run_limit,
            daily_export_limit: next.daily_export_limit,
            daily_provider_cost_ceiling:
              next.daily_provider_cost_ceiling != null
                ? Number(next.daily_provider_cost_ceiling)
                : null,
            effective,
          };
        });
      },
    );
  };
