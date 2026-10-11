import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { poolStats, sql, withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { resolveTenantLimits } from '../budgets/service.ts';
import { resolveWorkspaceControls } from './controls.ts';
import { snapshot } from './metrics.ts';
import { retentionReport, sweepExpiredEvidence } from './retention.ts';

const Controls = z.object({
  research: z.boolean(),
  discovery: z.boolean(),
  enrich: z.boolean(),
  ai: z.boolean(),
  export: z.boolean(),
});

const Status = z.object({
  database: z.enum(['ok', 'error']),
  redis: z.enum(['ok', 'skipped', 'error']),
  pool: z.object({ total: z.number(), idle: z.number(), waiting: z.number() }).nullable(),
  limits: z.object({
    research: z.number(),
    enrich: z.number(),
    ai: z.number(),
    export: z.number(),
    concurrent_jobs: z.number(),
  }),
  controls: Controls,
  requests: z.array(
    z.object({
      route: z.string(),
      count: z.number(),
      errors: z.number(),
      latency_ms_avg: z.number(),
    }),
  ),
  rate_limited: z.number(),
  uptime_seconds: z.number(),
  note: z.string(),
});

export const opsRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, config, redis } = deps;

    app.get(
      '/ops/status',
      { schema: { tags: ['ops'], response: { 200: Status } } },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.read');
        return withContext(db, ctx, async (trx) => {
          let database: 'ok' | 'error' = 'ok';
          try {
            await sql`SELECT 1`.execute(trx);
          } catch {
            database = 'error';
          }
          let redisStatus: 'ok' | 'skipped' | 'error' = 'skipped';
          if (redis) {
            try {
              const pong = await redis.ping();
              redisStatus = pong === 'PONG' ? 'ok' : 'error';
            } catch {
              redisStatus = 'error';
            }
          }
          const limits = await resolveTenantLimits(trx, ctx.tenantId, config);
          const controls = await resolveWorkspaceControls(trx, ctx.tenantId, config);
          const snap = snapshot();
          return {
            database,
            redis: redisStatus,
            pool: poolStats(db),
            limits: {
              research: limits.research,
              enrich: limits.enrich,
              ai: limits.ai,
              export: limits.export,
              concurrent_jobs: limits.concurrent_jobs,
            },
            controls,
            requests: snap.requests,
            rate_limited: snap.rate_limited,
            uptime_seconds: snap.uptime_seconds,
            note: 'Process-local metrics. This is not a production SLO dashboard or a 10K-user capacity claim.',
          };
        });
      },
    );

    app.get(
      '/workspace-controls',
      { schema: { tags: ['ops'], response: { 200: Controls } } },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.read');
        return withContext(db, ctx, (trx) => resolveWorkspaceControls(trx, ctx.tenantId, config));
      },
    );

    app.patch(
      '/workspace-controls',
      {
        schema: {
          tags: ['ops'],
          body: z
            .object({
              research_enabled: z.boolean().optional(),
              discovery_enabled: z.boolean().optional(),
              enrich_enabled: z.boolean().optional(),
              ai_enabled: z.boolean().optional(),
              export_enabled: z.boolean().optional(),
            })
            .strict(),
          response: { 200: Controls },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.manage');
        return withContext(db, ctx, async (trx) => {
          const current = await trx
            .selectFrom('workspace_controls')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .executeTakeFirst();
          const next = {
            research_enabled: request.body.research_enabled ?? current?.research_enabled ?? true,
            discovery_enabled: request.body.discovery_enabled ?? current?.discovery_enabled ?? true,
            enrich_enabled: request.body.enrich_enabled ?? current?.enrich_enabled ?? true,
            ai_enabled: request.body.ai_enabled ?? current?.ai_enabled ?? true,
            export_enabled: request.body.export_enabled ?? current?.export_enabled ?? true,
            updated_by: ctx.userId,
          };
          await trx
            .insertInto('workspace_controls')
            .values({ tenant_id: ctx.tenantId, ...next })
            .onConflict((oc) => oc.column('tenant_id').doUpdateSet(next))
            .execute();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'controls.updated',
            entityType: 'workspace_controls',
            entityId: ctx.tenantId,
            correlationId: ctx.correlationId,
            metadata: next,
          });
          return resolveWorkspaceControls(trx, ctx.tenantId, config);
        });
      },
    );

    app.get(
      '/ops/retention',
      {
        schema: {
          tags: ['ops'],
          response: {
            200: z.object({
              expired_evidence_with_excerpt: z.number(),
              suppression_hashes_retained: z.number(),
              note: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.read');
        return withContext(db, ctx, (trx) => retentionReport(trx, ctx.tenantId));
      },
    );

    app.post(
      '/ops/retention-sweep',
      {
        schema: {
          tags: ['ops'],
          response: { 200: z.object({ redacted: z.number() }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'ops.manage');
        return withContext(db, ctx, async (trx) => {
          const result = await sweepExpiredEvidence(trx, ctx.tenantId);
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'retention.sweep',
            entityType: 'evidence',
            entityId: ctx.tenantId,
            correlationId: ctx.correlationId,
            metadata: result,
          });
          return result;
        });
      },
    );
  };
