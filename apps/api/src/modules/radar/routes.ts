import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { isFlagEnabled } from '../rollout/flags.ts';
import { claimTypeLabel } from './decay.ts';
import { parseStringArray, refreshRadarFeed } from './refresh.ts';

const ClaimType = z.enum(['source_fact', 'provider_fact', 'model_inference', 'user_assertion']);

const Opportunity = z.object({
  id: z.uuid(),
  company_id: z.uuid(),
  company_domain: z.string().nullable(),
  company_name: z.string().nullable(),
  opportunity_kind: z.enum(['signal', 'product_match', 'announcement']),
  title: z.string(),
  summary: z.string(),
  claim_type: ClaimType,
  claim_label: z.string(),
  confidence: z.number(),
  freshness_score: z.number().int(),
  observed_at: z.string(),
  status: z.enum(['open', 'dismissed', 'snoozed']),
  note: z.string(),
});

const Mission = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(['active', 'paused']),
  interval_hours: z.number().int(),
  daily_run_budget: z.number().int(),
  runs_today: z.number().int(),
  last_run_at: z.string().nullable(),
  next_run_at: z.string().nullable(),
  target_countries: z.array(z.string()),
  target_industries: z.array(z.string()),
  temporal_schedule_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

async function requireRadarFlag(
  trx: Parameters<typeof isFlagEnabled>[0],
  tenantId: string,
  key: 'opportunity_radar' | 'radar_missions',
) {
  if (!(await isFlagEnabled(trx, tenantId, key))) {
    throw new AppError('FEATURE_DISABLED', `Feature flag "${key}" is disabled for this workspace.`);
  }
}

function toMission(row: {
  id: string;
  name: string;
  status: string;
  interval_hours: number;
  daily_run_budget: number;
  runs_today: number;
  last_run_at: Date | null;
  next_run_at: Date | null;
  target_countries: unknown;
  target_industries: unknown;
  temporal_schedule_id: string | null;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    status: row.status as 'active' | 'paused',
    interval_hours: row.interval_hours,
    daily_run_budget: row.daily_run_budget,
    runs_today: row.runs_today,
    last_run_at: row.last_run_at?.toISOString() ?? null,
    next_run_at: row.next_run_at?.toISOString() ?? null,
    target_countries: parseStringArray(row.target_countries),
    target_industries: parseStringArray(row.target_industries),
    temporal_schedule_id: row.temporal_schedule_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Calendar day matching node-pg DATE (local midnight), not UTC ISO date. */
function calendarDateString(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function asDateOnly(value: string | Date): string {
  if (value instanceof Date) return calendarDateString(value);
  return String(value).slice(0, 10);
}

export const radarRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/opportunity-radar',
      {
        schema: {
          tags: ['radar'],
          querystring: z.object({
            status: z.enum(['open', 'dismissed', 'snoozed']).optional().default('open'),
            min_freshness: z.coerce.number().int().min(0).max(100).optional().default(1),
            limit: z.coerce.number().int().min(1).max(100).optional().default(40),
          }),
          response: {
            200: z.object({
              data: z.array(Opportunity),
              note: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'radar.read');
        return withContext(db, ctx, async (trx) => {
          await requireRadarFlag(trx, ctx.tenantId, 'opportunity_radar');
          const { status, min_freshness, limit } = request.query;
          const rows = await trx
            .selectFrom('market_opportunities as o')
            .innerJoin('companies as c', 'c.id', 'o.company_id')
            .select([
              'o.id',
              'o.company_id',
              'o.opportunity_kind',
              'o.title',
              'o.summary',
              'o.claim_type',
              'o.confidence',
              'o.freshness_score',
              'o.observed_at',
              'o.status',
              'c.primary_domain',
              'c.canonical_name',
            ])
            .where('o.tenant_id', '=', ctx.tenantId)
            .where('o.status', '=', status)
            .where('o.freshness_score', '>=', min_freshness)
            .orderBy('o.freshness_score', 'desc')
            .orderBy('o.observed_at', 'desc')
            .limit(limit)
            .execute();
          return {
            note: 'Radar items decay with age. claim_label distinguishes verified_source vs model_inference. Not buying intent.',
            data: rows.map((r) => ({
              id: r.id,
              company_id: r.company_id,
              company_domain: r.primary_domain,
              company_name: r.canonical_name,
              opportunity_kind: r.opportunity_kind as 'signal' | 'product_match' | 'announcement',
              title: r.title,
              summary: r.summary,
              claim_type: r.claim_type as z.infer<typeof ClaimType>,
              claim_label: claimTypeLabel(r.claim_type as z.infer<typeof ClaimType>),
              confidence: Number(r.confidence),
              freshness_score: r.freshness_score,
              observed_at: r.observed_at.toISOString(),
              status: r.status as 'open' | 'dismissed' | 'snoozed',
              note: 'Not confirmed buying intent.',
            })),
          };
        });
      },
    );

    app.post(
      '/opportunity-radar/refresh',
      {
        schema: {
          tags: ['radar'],
          response: {
            200: z.object({
              from_signals: z.number().int(),
              from_matches: z.number().int(),
              upserted: z.number().int(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'radar.write');
        return withContext(db, ctx, async (trx) => {
          await requireRadarFlag(trx, ctx.tenantId, 'opportunity_radar');
          const result = await refreshRadarFeed(trx, ctx.tenantId);
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'radar.refresh',
            entityType: 'tenant',
            entityId: ctx.tenantId,
            correlationId: ctx.correlationId,
            metadata: { ...result },
          });
          return result;
        });
      },
    );

    app.patch(
      '/opportunity-radar/:id',
      {
        schema: {
          tags: ['radar'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            status: z.enum(['open', 'dismissed', 'snoozed']),
          }),
          response: { 200: Opportunity },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'radar.write');
        return withContext(db, ctx, async (trx) => {
          await requireRadarFlag(trx, ctx.tenantId, 'opportunity_radar');
          const updated = await trx
            .updateTable('market_opportunities')
            .set({ status: request.body.status })
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .returning(['id'])
            .executeTakeFirst();
          if (!updated) throw notFound('Opportunity');
          const row = await trx
            .selectFrom('market_opportunities as o')
            .innerJoin('companies as c', 'c.id', 'o.company_id')
            .select([
              'o.id',
              'o.company_id',
              'o.opportunity_kind',
              'o.title',
              'o.summary',
              'o.claim_type',
              'o.confidence',
              'o.freshness_score',
              'o.observed_at',
              'o.status',
              'c.primary_domain',
              'c.canonical_name',
            ])
            .where('o.tenant_id', '=', ctx.tenantId)
            .where('o.id', '=', request.params.id)
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'radar.opportunity_updated',
            entityType: 'market_opportunity',
            entityId: row.id,
            correlationId: ctx.correlationId,
            metadata: { status: request.body.status },
          });
          return {
            id: row.id,
            company_id: row.company_id,
            company_domain: row.primary_domain,
            company_name: row.canonical_name,
            opportunity_kind: row.opportunity_kind as 'signal' | 'product_match' | 'announcement',
            title: row.title,
            summary: row.summary,
            claim_type: row.claim_type as z.infer<typeof ClaimType>,
            claim_label: claimTypeLabel(row.claim_type as z.infer<typeof ClaimType>),
            confidence: Number(row.confidence),
            freshness_score: row.freshness_score,
            observed_at: row.observed_at.toISOString(),
            status: row.status as 'open' | 'dismissed' | 'snoozed',
            note: 'Not confirmed buying intent.',
          };
        });
      },
    );

    app.get(
      '/radar-missions',
      {
        schema: {
          tags: ['radar'],
          response: { 200: z.object({ data: z.array(Mission), note: z.string() }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'mission.manage');
        return withContext(db, ctx, async (trx) => {
          await requireRadarFlag(trx, ctx.tenantId, 'radar_missions');
          const rows = await trx
            .selectFrom('radar_missions')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .orderBy('created_at', 'desc')
            .execute();
          return {
            note: 'Missions store pause/resume + daily budget. Temporal Schedule id is reserved; run-now refreshes the feed synchronously in Phase 13.',
            data: rows.map(toMission),
          };
        });
      },
    );

    app.post(
      '/radar-missions',
      {
        schema: {
          tags: ['radar'],
          body: z.object({
            name: z.string().min(1).max(120),
            interval_hours: z.number().int().min(1).max(168).optional().default(24),
            daily_run_budget: z.number().int().min(1).max(48).optional().default(4),
            target_countries: z.array(z.string().length(2)).max(50).optional().default([]),
            target_industries: z.array(z.string().min(1).max(80)).max(50).optional().default([]),
          }),
          response: { 201: Mission },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'mission.manage');
        const mission = await withContext(db, ctx, async (trx) => {
          await requireRadarFlag(trx, ctx.tenantId, 'radar_missions');
          const next = new Date(Date.now() + request.body.interval_hours * 3_600_000);
          const row = await trx
            .insertInto('radar_missions')
            .values({
              tenant_id: ctx.tenantId,
              name: request.body.name,
              status: 'active',
              interval_hours: request.body.interval_hours,
              daily_run_budget: request.body.daily_run_budget,
              next_run_at: next,
              target_countries: JSON.stringify(request.body.target_countries),
              target_industries: JSON.stringify(request.body.target_industries),
              created_by: ctx.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'radar.mission_created',
            entityType: 'radar_mission',
            entityId: row.id,
            correlationId: ctx.correlationId,
            metadata: { name: row.name },
          });
          return toMission(row);
        });
        return reply.status(201).send(mission);
      },
    );

    app.patch(
      '/radar-missions/:id',
      {
        schema: {
          tags: ['radar'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            status: z.enum(['active', 'paused']).optional(),
            interval_hours: z.number().int().min(1).max(168).optional(),
            daily_run_budget: z.number().int().min(1).max(48).optional(),
            name: z.string().min(1).max(120).optional(),
          }),
          response: { 200: Mission },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'mission.manage');
        return withContext(db, ctx, async (trx) => {
          await requireRadarFlag(trx, ctx.tenantId, 'radar_missions');
          const existing = await trx
            .selectFrom('radar_missions')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!existing) throw notFound('Mission');
          const row = await trx
            .updateTable('radar_missions')
            .set({
              status: request.body.status ?? existing.status,
              interval_hours: request.body.interval_hours ?? existing.interval_hours,
              daily_run_budget: request.body.daily_run_budget ?? existing.daily_run_budget,
              name: request.body.name ?? existing.name,
              updated_by: ctx.userId,
            })
            .where('id', '=', existing.id)
            .where('tenant_id', '=', ctx.tenantId)
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'radar.mission_updated',
            entityType: 'radar_mission',
            entityId: row.id,
            correlationId: ctx.correlationId,
            metadata: request.body,
          });
          return toMission(row);
        });
      },
    );

    app.post(
      '/radar-missions/:id/run',
      {
        schema: {
          tags: ['radar'],
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              status: z.enum(['succeeded', 'skipped_budget', 'skipped_paused']),
              opportunities_upserted: z.number().int(),
              mission: Mission,
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'mission.manage');
        return withContext(db, ctx, async (trx) => {
          await requireRadarFlag(trx, ctx.tenantId, 'radar_missions');
          const mission = await trx
            .selectFrom('radar_missions')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!mission) throw notFound('Mission');

          const today = calendarDateString();
          let runsToday = mission.runs_today;
          if (asDateOnly(mission.runs_today_on) !== today) {
            runsToday = 0;
          }

          if (mission.status === 'paused') {
            await trx
              .insertInto('radar_mission_runs')
              .values({
                tenant_id: ctx.tenantId,
                mission_id: mission.id,
                status: 'skipped_paused',
                opportunities_upserted: 0,
                detail: JSON.stringify({ reason: 'paused' }),
              })
              .execute();
            return {
              status: 'skipped_paused' as const,
              opportunities_upserted: 0,
              mission: toMission(mission),
            };
          }

          if (runsToday >= mission.daily_run_budget) {
            await trx
              .insertInto('radar_mission_runs')
              .values({
                tenant_id: ctx.tenantId,
                mission_id: mission.id,
                status: 'skipped_budget',
                opportunities_upserted: 0,
                detail: JSON.stringify({ runs_today: runsToday, budget: mission.daily_run_budget }),
              })
              .execute();
            return {
              status: 'skipped_budget' as const,
              opportunities_upserted: 0,
              mission: toMission({ ...mission, runs_today: runsToday }),
            };
          }

          const refresh = await refreshRadarFeed(trx, ctx.tenantId, {
            countries: parseStringArray(mission.target_countries),
            industries: parseStringArray(mission.target_industries),
          });
          const now = new Date();
          const updated = await trx
            .updateTable('radar_missions')
            .set({
              runs_today: runsToday + 1,
              runs_today_on: today,
              last_run_at: now,
              next_run_at: new Date(now.getTime() + mission.interval_hours * 3_600_000),
              updated_by: ctx.userId,
            })
            .where('id', '=', mission.id)
            .where('tenant_id', '=', ctx.tenantId)
            .returningAll()
            .executeTakeFirstOrThrow();

          await trx
            .insertInto('radar_mission_runs')
            .values({
              tenant_id: ctx.tenantId,
              mission_id: mission.id,
              status: 'succeeded',
              opportunities_upserted: refresh.upserted,
              detail: JSON.stringify(refresh),
            })
            .execute();

          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'radar.mission_run',
            entityType: 'radar_mission',
            entityId: mission.id,
            correlationId: ctx.correlationId,
            metadata: { ...refresh },
          });

          return {
            status: 'succeeded' as const,
            opportunities_upserted: refresh.upserted,
            mission: toMission(updated),
          };
        });
      },
    );
  };
