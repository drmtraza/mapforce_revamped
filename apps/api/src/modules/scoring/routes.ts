import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { loadCompany } from '../companies/routes.ts';
import { IcpDefinition } from '../icp/routes.ts';
import { scoreCompany } from './engine.ts';
import { icpFromDefinition, loadScoreInput } from './gather.ts';
import { DEFAULT_WEIGHTS, parseWeights, SCORING_VERSION_LABEL } from './weights.ts';

const Weights = z.object({
  icp_fit: z.number().int().min(0).max(100),
  role_relevance: z.number().int().min(0).max(100),
  intent: z.number().int().min(0).max(100),
  completeness: z.number().int().min(0).max(100),
  corroboration: z.number().int().min(0).max(100),
});

const Factor = z.object({
  key: z.string(),
  value: z.number(),
  max: z.number(),
  rationale: z.string(),
});

const Score = z.object({
  id: z.string(),
  company_id: z.string(),
  total_score: z.number(),
  eligible: z.boolean(),
  suppression_override: z.boolean(),
  scoring_version: z.number(),
  scoring_label: z.string(),
  factors: z.array(Factor),
  explanation: z.string(),
  created_at: z.string(),
});

const Policy = z.object({
  id: z.string(),
  version: z.number(),
  weights: Weights,
  label: z.string(),
  created_at: z.string(),
});

async function ensurePolicy(
  trx: Parameters<typeof loadScoreInput>[0],
  tenantId: string,
  userId: string,
) {
  const current = await trx
    .selectFrom('scoring_policies')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('active', '=', true)
    .executeTakeFirst();
  if (current) return current;
  return trx
    .insertInto('scoring_policies')
    .values({
      tenant_id: tenantId,
      version: 1,
      weights: JSON.stringify(DEFAULT_WEIGHTS),
      created_by: userId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export const scoringRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/scoring-policies',
      {
        schema: { tags: ['scoring'], response: { 200: Policy } },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'icp.read');
        const row = await withContext(db, ctx, (trx) =>
          ensurePolicy(trx, ctx.tenantId, ctx.userId),
        );
        return {
          id: row.id,
          version: row.version,
          weights: parseWeights(row.weights),
          label: SCORING_VERSION_LABEL,
          created_at: row.created_at.toISOString(),
        };
      },
    );

    app.post(
      '/scoring-policies',
      {
        schema: {
          tags: ['scoring'],
          body: z.object({ expected_version: z.number().int().min(1), weights: Weights }),
          response: { 201: Policy },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'icp.write');
        const weights = parseWeights(request.body.weights);
        const row = await withContext(db, ctx, async (trx) => {
          const current = await ensurePolicy(trx, ctx.tenantId, ctx.userId);
          if (current.version !== request.body.expected_version) {
            throw new AppError('CONFLICT', 'Scoring policy was modified; reload and retry.');
          }
          await trx
            .updateTable('scoring_policies')
            .set({ active: false })
            .where('id', '=', current.id)
            .execute();
          const next = await trx
            .insertInto('scoring_policies')
            .values({
              tenant_id: ctx.tenantId,
              version: current.version + 1,
              weights: JSON.stringify(weights),
              created_by: ctx.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'scoring.policy.updated',
            entityType: 'scoring_policy',
            entityId: next.id,
            correlationId: ctx.correlationId,
            metadata: { from_version: current.version, to_version: next.version },
          });
          return next;
        });
        return reply.status(201).send({
          id: row.id,
          version: row.version,
          weights,
          label: SCORING_VERSION_LABEL,
          created_at: row.created_at.toISOString(),
        });
      },
    );

    app.post(
      '/icp-profiles/:id/score-runs',
      {
        schema: {
          tags: ['scoring'],
          params: z.object({ id: z.uuid() }),
          body: z.object({ company_ids: z.array(z.uuid()).max(200).optional() }).default({}),
          response: {
            200: z.object({
              scoring_version: z.number(),
              data: z.array(Score),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'score.run');
        return withContext(db, ctx, async (trx) => {
          const icp = await trx
            .selectFrom('icp_profiles')
            .select(['id', 'definition', 'active'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!icp || !icp.active) throw notFound('ICP profile');
          const policy = await ensurePolicy(trx, ctx.tenantId, ctx.userId);
          const weights = parseWeights(policy.weights);
          const icpDef = icpFromDefinition(IcpDefinition.parse(icp.definition));
          let companyIds = request.body.company_ids ?? [];
          if (companyIds.length === 0) {
            const rows = await trx
              .selectFrom('companies')
              .select('id')
              .where('tenant_id', '=', ctx.tenantId)
              .orderBy('created_at', 'desc')
              .limit(200)
              .execute();
            companyIds = rows.map((r) => r.id);
          }
          const data = [];
          for (const companyId of companyIds) {
            const input = await loadScoreInput(trx, ctx.tenantId, companyId);
            if (!input) continue;
            const scored = scoreCompany(input, icpDef, weights);
            const row = await trx
              .insertInto('score_runs')
              .values({
                tenant_id: ctx.tenantId,
                company_id: companyId,
                icp_profile_id: icp.id,
                scoring_policy_id: policy.id,
                scoring_version: policy.version,
                total_score: scored.total,
                eligible: scored.eligible,
                suppression_override: scored.suppression_override,
                factors: JSON.stringify(scored.factors),
                explanation: scored.explanation,
              })
              .returning(['id', 'created_at'])
              .executeTakeFirstOrThrow();
            data.push({
              id: row.id,
              company_id: companyId,
              total_score: scored.total,
              eligible: scored.eligible,
              suppression_override: scored.suppression_override,
              scoring_version: policy.version,
              scoring_label: SCORING_VERSION_LABEL,
              factors: scored.factors,
              explanation: scored.explanation,
              created_at: row.created_at.toISOString(),
            });
          }
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'scoring.ran',
            entityType: 'icp_profile',
            entityId: icp.id,
            correlationId: ctx.correlationId,
            metadata: { companies: data.length, scoring_version: policy.version },
          });
          return { scoring_version: policy.version, data };
        });
      },
    );

    app.get(
      '/score-runs/:id',
      {
        schema: { tags: ['scoring'], params: z.object({ id: z.uuid() }), response: { 200: Score } },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        const row = await withContext(db, ctx, (trx) =>
          trx
            .selectFrom('score_runs')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst(),
        );
        if (!row) throw notFound('Score run');
        return {
          id: row.id,
          company_id: row.company_id,
          total_score: row.total_score,
          eligible: row.eligible,
          suppression_override: row.suppression_override,
          scoring_version: row.scoring_version,
          scoring_label: SCORING_VERSION_LABEL,
          factors: row.factors as z.infer<typeof Factor>[],
          explanation: row.explanation,
          created_at: row.created_at.toISOString(),
        };
      },
    );

    app.get(
      '/companies/:id/score',
      {
        schema: {
          tags: ['scoring'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ score: Score.nullable() }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        const row = await withContext(db, ctx, async (trx) => {
          await loadCompany(trx, ctx.tenantId, request.params.id);
          return trx
            .selectFrom('score_runs')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', request.params.id)
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst();
        });
        if (!row) return { score: null };
        return {
          score: {
            id: row.id,
            company_id: row.company_id,
            total_score: row.total_score,
            eligible: row.eligible,
            suppression_override: row.suppression_override,
            scoring_version: row.scoring_version,
            scoring_label: SCORING_VERSION_LABEL,
            factors: row.factors as z.infer<typeof Factor>[],
            explanation: row.explanation,
            created_at: row.created_at.toISOString(),
          },
        };
      },
    );
  };
