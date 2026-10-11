import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql, withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { resolveTenantLimits } from '../budgets/service.ts';
import { listFlags } from './flags.ts';
import { isPlanId, planCaps } from './plans.ts';
import { dataQualityReport } from './quality.ts';

async function betaSeatCount(trx: Parameters<typeof listFlags>[0]): Promise<number> {
  const row = await sql<{ n: number }>`SELECT count_tenants_on_plan('beta') AS n`.execute(trx);
  return Number(row.rows[0]?.n ?? 0);
}

const Flag = z.object({
  key: z.string(),
  description: z.string(),
  global_enabled: z.boolean(),
  tenant_override: z.boolean().nullable(),
  effective: z.boolean(),
});

const Feedback = z.object({
  id: z.string(),
  category: z.string(),
  body: z.string(),
  status: z.string(),
  created_at: z.string(),
});

const Incident = z.object({
  id: z.string(),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  summary: z.string(),
  status: z.enum(['open', 'mitigating', 'resolved']),
  created_at: z.string(),
});

export const rolloutRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, config } = deps;

    app.get(
      '/rollout',
      {
        schema: {
          tags: ['rollout'],
          response: {
            200: z.object({
              plan_id: z.string(),
              plan_caps: z.object({
                research: z.number(),
                enrich: z.number(),
                ai: z.number(),
                export: z.number(),
                provider_cost: z.number(),
                concurrent_jobs: z.number(),
              }),
              effective_limits: z.object({
                research: z.number(),
                enrich: z.number(),
                ai: z.number(),
                export: z.number(),
                provider_cost: z.number(),
                concurrent_jobs: z.number(),
                plan_id: z.string(),
              }),
              flags: z.array(Flag),
              note: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'workspace.read');
        return withContext(db, ctx, async (trx) => {
          const limits = await resolveTenantLimits(trx, ctx.tenantId, config);
          const flags = await listFlags(trx, ctx.tenantId);
          return {
            plan_id: limits.plan_id,
            plan_caps: planCaps(limits.plan_id),
            effective_limits: limits,
            flags,
            note: 'Beta plans use tighter ceilings. Plan caps are not a capacity proof.',
          };
        });
      },
    );

    app.patch(
      '/rollout/plan',
      {
        schema: {
          tags: ['rollout'],
          body: z.object({
            plan_id: z.enum(['development', 'beta', 'ga']),
            rollout_notes: z.string().trim().max(2000).nullable().optional(),
          }),
          response: {
            200: z.object({ plan_id: z.string(), rollout_notes: z.string().nullable() }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.manage');
        return withContext(db, ctx, async (trx) => {
          const current = await trx
            .selectFrom('tenants')
            .select(['plan_id', 'rollout_notes'])
            .where('id', '=', ctx.tenantId)
            .executeTakeFirst();
          if (!current) throw notFound('Workspace');
          if (request.body.plan_id === 'beta' && current.plan_id !== 'beta') {
            if ((await betaSeatCount(trx)) >= config.MAX_BETA_TENANTS) {
              throw new AppError(
                'QUOTA_EXCEEDED',
                `At most ${config.MAX_BETA_TENANTS} beta workspaces are allowed.`,
              );
            }
          }
          const updated = await trx
            .updateTable('tenants')
            .set({
              plan_id: request.body.plan_id,
              ...(request.body.rollout_notes !== undefined
                ? { rollout_notes: request.body.rollout_notes }
                : {}),
            })
            .where('id', '=', ctx.tenantId)
            .returning(['plan_id', 'rollout_notes'])
            .executeTakeFirst();
          if (!updated) throw notFound('Workspace');
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'rollout.plan_updated',
            entityType: 'workspace',
            entityId: ctx.tenantId,
            correlationId: ctx.correlationId,
            metadata: { plan_id: updated.plan_id },
          });
          return updated;
        });
      },
    );

    app.get(
      '/feature-flags',
      { schema: { tags: ['rollout'], response: { 200: z.object({ data: z.array(Flag) }) } } },
      async (request) => {
        const ctx = await requireTenant(db, request, 'workspace.read');
        const data = await withContext(db, ctx, (trx) => listFlags(trx, ctx.tenantId));
        return { data };
      },
    );

    app.patch(
      '/feature-flags/:key',
      {
        schema: {
          tags: ['rollout'],
          params: z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/) }),
          body: z.object({ enabled: z.boolean() }).strict(),
          response: { 200: Flag },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.manage');
        return withContext(db, ctx, async (trx) => {
          const flag = await trx
            .selectFrom('feature_flags')
            .selectAll()
            .where('key', '=', request.params.key)
            .executeTakeFirst();
          if (!flag) throw notFound('Feature flag');
          await trx
            .insertInto('tenant_feature_overrides')
            .values({
              tenant_id: ctx.tenantId,
              flag_key: flag.key,
              enabled: request.body.enabled,
              updated_by: ctx.userId,
            })
            .onConflict((oc) =>
              oc.columns(['tenant_id', 'flag_key']).doUpdateSet({
                enabled: request.body.enabled,
                updated_by: ctx.userId,
              }),
            )
            .execute();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'feature_flag.override',
            entityType: 'feature_flag',
            entityId: flag.key,
            correlationId: ctx.correlationId,
            metadata: { enabled: request.body.enabled },
          });
          const found = (await listFlags(trx, ctx.tenantId)).find((f) => f.key === flag.key);
          if (!found) throw notFound('Feature flag');
          return found;
        });
      },
    );

    app.post(
      '/feedback',
      {
        schema: {
          tags: ['rollout'],
          body: z.object({
            category: z.enum(['bug', 'data_quality', 'ux', 'request', 'other']),
            body: z.string().trim().min(1).max(4000),
          }),
          response: { 201: Feedback },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'workspace.read');
        const row = await withContext(db, ctx, async (trx) => {
          const inserted = await trx
            .insertInto('feedback_items')
            .values({
              tenant_id: ctx.tenantId,
              author_user_id: ctx.userId,
              category: request.body.category,
              body: request.body.body,
            })
            .returning(['id', 'category', 'body', 'status', 'created_at'])
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'feedback.created',
            entityType: 'feedback',
            entityId: inserted.id,
            correlationId: ctx.correlationId,
            metadata: { category: inserted.category },
          });
          return inserted;
        });
        return reply.status(201).send({
          id: row.id,
          category: row.category,
          body: row.body,
          status: row.status,
          created_at: row.created_at.toISOString(),
        });
      },
    );

    app.get(
      '/feedback',
      { schema: { tags: ['rollout'], response: { 200: z.object({ data: z.array(Feedback) }) } } },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.read');
        const rows = await withContext(db, ctx, (trx) =>
          trx
            .selectFrom('feedback_items')
            .select(['id', 'category', 'body', 'status', 'created_at'])
            .where('tenant_id', '=', ctx.tenantId)
            .orderBy('created_at', 'desc')
            .limit(100)
            .execute(),
        );
        return {
          data: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
        };
      },
    );

    app.get(
      '/ops/data-quality',
      {
        schema: {
          tags: ['rollout'],
          response: {
            200: z.object({
              people: z.object({
                unreviewed: z.number(),
                accepted: z.number(),
                rejected: z.number(),
                disputed: z.number(),
              }),
              ai_quarantine: z.number(),
              disputed_claims: z.number(),
              suppressions: z.number(),
              open_feedback: z.number(),
              open_incidents: z.number(),
              note: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.read');
        return withContext(db, ctx, (trx) => dataQualityReport(trx, ctx.tenantId));
      },
    );

    app.get(
      '/ops/incidents',
      { schema: { tags: ['rollout'], response: { 200: z.object({ data: z.array(Incident) }) } } },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.read');
        const rows = await withContext(db, ctx, (trx) =>
          trx
            .selectFrom('incident_triage_notes')
            .select(['id', 'severity', 'summary', 'status', 'created_at'])
            .where('tenant_id', '=', ctx.tenantId)
            .orderBy('created_at', 'desc')
            .limit(50)
            .execute(),
        );
        return {
          data: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
        };
      },
    );

    app.post(
      '/ops/incidents',
      {
        schema: {
          tags: ['rollout'],
          body: z.object({
            severity: z.enum(['P0', 'P1', 'P2', 'P3']),
            summary: z.string().trim().min(1).max(500),
          }),
          response: { 201: Incident },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'ops.manage');
        const row = await withContext(db, ctx, async (trx) => {
          const inserted = await trx
            .insertInto('incident_triage_notes')
            .values({
              tenant_id: ctx.tenantId,
              author_user_id: ctx.userId,
              severity: request.body.severity,
              summary: request.body.summary,
            })
            .returning(['id', 'severity', 'summary', 'status', 'created_at'])
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'incident.opened',
            entityType: 'incident',
            entityId: inserted.id,
            correlationId: ctx.correlationId,
            metadata: { severity: inserted.severity },
          });
          return inserted;
        });
        return reply.status(201).send({
          ...row,
          created_at: row.created_at.toISOString(),
        });
      },
    );

    app.patch(
      '/ops/incidents/:id',
      {
        schema: {
          tags: ['rollout'],
          params: z.object({ id: z.uuid() }),
          body: z.object({ status: z.enum(['open', 'mitigating', 'resolved']) }),
          response: { 200: Incident },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.manage');
        return withContext(db, ctx, async (trx) => {
          const updated = await trx
            .updateTable('incident_triage_notes')
            .set({ status: request.body.status })
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .returning(['id', 'severity', 'summary', 'status', 'created_at'])
            .executeTakeFirst();
          if (!updated) throw notFound('Incident');
          return { ...updated, created_at: updated.created_at.toISOString() };
        });
      },
    );

    app.post(
      '/ops/synthetic-check',
      {
        schema: {
          tags: ['rollout'],
          response: {
            200: z.object({
              ok: z.boolean(),
              latency_ms: z.number(),
              checks: z.record(z.string(), z.string()),
              id: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.read');
        const started = Date.now();
        return withContext(db, ctx, async (trx) => {
          const checks: Record<string, string> = { database: 'ok' };
          try {
            await sql`SELECT 1`.execute(trx);
          } catch {
            checks.database = 'error';
          }
          const ok = checks.database === 'ok';
          const latency_ms = Date.now() - started;
          const row = await trx
            .insertInto('synthetic_check_runs')
            .values({
              tenant_id: ctx.tenantId,
              check_name: 'workspace_ready',
              ok,
              latency_ms,
              detail: JSON.stringify(checks),
            })
            .returning(['id'])
            .executeTakeFirstOrThrow();
          return { ok, latency_ms, checks, id: row.id };
        });
      },
    );

    app.get(
      '/ops/synthetic-checks',
      {
        schema: {
          tags: ['rollout'],
          response: {
            200: z.object({
              data: z.array(
                z.object({
                  id: z.string(),
                  check_name: z.string(),
                  ok: z.boolean(),
                  latency_ms: z.number(),
                  created_at: z.string(),
                }),
              ),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.read');
        const rows = await withContext(db, ctx, (trx) =>
          trx
            .selectFrom('synthetic_check_runs')
            .select(['id', 'check_name', 'ok', 'latency_ms', 'created_at'])
            .where('tenant_id', '=', ctx.tenantId)
            .orderBy('created_at', 'desc')
            .limit(50)
            .execute(),
        );
        return {
          data: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
        };
      },
    );

    app.post(
      '/workspace-budget/ramp',
      {
        schema: {
          tags: ['rollout'],
          body: z.object({
            field: z.enum([
              'daily_research_job_limit',
              'daily_enrich_limit',
              'daily_ai_run_limit',
              'daily_export_limit',
            ]),
            next_value: z.number().int().min(0).max(100_000),
            rationale: z.string().trim().min(3).max(500),
          }),
          response: {
            200: z.object({
              field: z.string(),
              previous_value: z.number().nullable(),
              next_value: z.number(),
              plan_ceiling: z.number(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'budget.manage');
        return withContext(db, ctx, async (trx) => {
          const limits = await resolveTenantLimits(trx, ctx.tenantId, config);
          if (!isPlanId(limits.plan_id)) throw new AppError('INVALID_STATE', 'Unknown plan.');
          const caps = planCaps(limits.plan_id);
          const ceilingMap = {
            daily_research_job_limit: caps.research,
            daily_enrich_limit: caps.enrich,
            daily_ai_run_limit: caps.ai,
            daily_export_limit: caps.export,
          } as const;
          const ceiling = ceilingMap[request.body.field];
          if (request.body.next_value > ceiling) {
            throw new AppError(
              'QUOTA_EXCEEDED',
              `Plan ${limits.plan_id} ceiling for ${request.body.field} is ${ceiling}.`,
            );
          }
          const current = await trx
            .selectFrom('tenant_budgets')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .executeTakeFirst();
          const previous = current?.[request.body.field] ?? null;
          const patch = { [request.body.field]: request.body.next_value, updated_by: ctx.userId };
          await trx
            .insertInto('tenant_budgets')
            .values({
              tenant_id: ctx.tenantId,
              daily_research_job_limit: current?.daily_research_job_limit ?? null,
              daily_enrich_limit: current?.daily_enrich_limit ?? null,
              daily_ai_run_limit: current?.daily_ai_run_limit ?? null,
              daily_export_limit: current?.daily_export_limit ?? null,
              ...patch,
            })
            .onConflict((oc) => oc.column('tenant_id').doUpdateSet(patch))
            .execute();
          await trx
            .insertInto('quota_ramp_events')
            .values({
              tenant_id: ctx.tenantId,
              actor_user_id: ctx.userId,
              field: request.body.field,
              previous_value: previous,
              next_value: request.body.next_value,
              plan_ceiling: ceiling,
              rationale: request.body.rationale,
            })
            .execute();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'budget.ramped',
            entityType: 'tenant_budget',
            entityId: ctx.tenantId,
            correlationId: ctx.correlationId,
            metadata: {
              field: request.body.field,
              next_value: request.body.next_value,
              plan_ceiling: ceiling,
            },
          });
          return {
            field: request.body.field,
            previous_value: previous,
            next_value: request.body.next_value,
            plan_ceiling: ceiling,
          };
        });
      },
    );
  };
