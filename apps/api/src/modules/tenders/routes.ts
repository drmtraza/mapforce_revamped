import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { isFlagEnabled } from '../rollout/flags.ts';
import { assessBidNoBid, parseCountries } from './bid.ts';
import { mockTenderNotices } from './mock.ts';

const Category = z.enum([
  'cybersecurity',
  'cloud',
  'software',
  'professional_services',
  'infrastructure',
  'other',
]);

const Tender = z.object({
  id: z.uuid(),
  company_id: z.string().nullable(),
  external_ref: z.string(),
  title: z.string(),
  summary: z.string(),
  buyer_name: z.string(),
  country_code: z.string().nullable(),
  category: Category,
  status: z.enum(['open', 'closed', 'awarded', 'cancelled', 'watching']),
  published_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  source_key: z.string(),
  source_url: z.string(),
  claim_type: z.string(),
  created_at: z.string(),
});

const Assessment = z.object({
  id: z.uuid(),
  tender_id: z.uuid(),
  recommendation: z.enum(['bid', 'no_bid', 'review']),
  fit_score: z.number().int(),
  factors: z.array(
    z.object({
      key: z.string(),
      value: z.number(),
      max: z.number(),
      rationale: z.string(),
    }),
  ),
  missing_information: z.array(z.string()),
  note: z.string(),
  human_decision: z.enum(['bid', 'no_bid', 'defer']).nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
});

const Competitor = z.object({
  id: z.uuid(),
  name: z.string(),
  domain: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(['watching', 'archived']),
  created_at: z.string(),
});

const Battlecard = z.object({
  id: z.uuid(),
  competitor_id: z.uuid(),
  version: z.number().int(),
  strengths: z.string(),
  weaknesses: z.string(),
  landmines: z.string(),
  our_differentiators: z.string(),
  certifications_note: z.string(),
  evidence_ids: z.array(z.string()),
  claim_type: z.string(),
  created_at: z.string(),
});

function asStringArray(value: unknown): string[] {
  return parseCountries(value);
}

async function requireFlag(
  trx: Parameters<typeof isFlagEnabled>[0],
  tenantId: string,
  key: 'tenders' | 'competitors',
) {
  if (!(await isFlagEnabled(trx, tenantId, key))) {
    throw new AppError('FEATURE_DISABLED', `Feature flag "${key}" is disabled for this workspace.`);
  }
}

function toTender(row: {
  id: string;
  company_id: string | null;
  external_ref: string;
  title: string;
  summary: string;
  buyer_name: string;
  country_code: string | null;
  category: string;
  status: string;
  published_at: Date | null;
  closes_at: Date | null;
  source_key: string;
  source_url: string;
  claim_type: string;
  created_at: Date;
}) {
  return {
    id: row.id,
    company_id: row.company_id,
    external_ref: row.external_ref,
    title: row.title,
    summary: row.summary,
    buyer_name: row.buyer_name,
    country_code: row.country_code,
    category: row.category as z.infer<typeof Category>,
    status: row.status as z.infer<typeof Tender>['status'],
    published_at: row.published_at?.toISOString() ?? null,
    closes_at: row.closes_at?.toISOString() ?? null,
    source_key: row.source_key,
    source_url: row.source_url,
    claim_type: row.claim_type,
    created_at: row.created_at.toISOString(),
  };
}

function parseFactors(value: unknown) {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  return Assessment.shape.factors.parse(raw);
}

export const tenderRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/tenders',
      {
        schema: {
          tags: ['tenders'],
          querystring: z.object({
            status: z.enum(['open', 'closed', 'awarded', 'cancelled', 'watching']).optional(),
          }),
          response: {
            200: z.object({ data: z.array(Tender), note: z.string() }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'tender.read');
        return withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'tenders');
          let q = trx
            .selectFrom('tenders')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .orderBy('created_at', 'desc')
            .limit(100);
          if (request.query.status) q = q.where('status', '=', request.query.status);
          const rows = await q.execute();
          return {
            note: 'Tender notices are workspace-scoped. Bids are never auto-submitted.',
            data: rows.map(toTender),
          };
        });
      },
    );

    app.post(
      '/tenders/sync-mock',
      {
        schema: {
          tags: ['tenders'],
          response: {
            200: z.object({ upserted: z.number().int(), note: z.string() }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'tender.write');
        return withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'tenders');
          const notices = mockTenderNotices(ctx.tenantId);
          let upserted = 0;
          for (const n of notices) {
            await trx
              .insertInto('tenders')
              .values({
                tenant_id: ctx.tenantId,
                external_ref: n.external_ref,
                title: n.title,
                summary: n.summary,
                buyer_name: n.buyer_name,
                country_code: n.country_code,
                category: n.category,
                status: 'open',
                published_at: new Date(n.published_at),
                closes_at: new Date(n.closes_at),
                source_key: 'mock_tenders',
                source_url: n.source_url,
                claim_type: 'provider_fact',
                evidence_ids: JSON.stringify([]),
                created_by: ctx.userId,
              })
              .onConflict((oc) =>
                oc.columns(['tenant_id', 'source_key', 'external_ref']).doUpdateSet({
                  title: n.title,
                  summary: n.summary,
                  closes_at: new Date(n.closes_at),
                  status: 'open',
                }),
              )
              .execute();
            upserted += 1;
          }
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'tender.mock_sync',
            entityType: 'tenant',
            entityId: ctx.tenantId,
            correlationId: ctx.correlationId,
            metadata: { upserted },
          });
          return {
            upserted,
            note: 'Mock tender sync only. Live adapters remain opt-in and off by default.',
          };
        });
      },
    );

    app.post(
      '/tenders/:id/bid-assessments',
      {
        schema: {
          tags: ['tenders'],
          params: z.object({ id: z.uuid() }),
          response: { 201: Assessment },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'tender.assess');
        const assessment = await withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'tenders');
          const tender = await trx
            .selectFrom('tenders')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!tender) throw notFound('Tender');
          const offerings = await trx
            .selectFrom('product_offerings')
            .select(['name', 'category', 'target_countries'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('status', '=', 'active')
            .limit(50)
            .execute();
          const result = assessBidNoBid(
            {
              title: tender.title,
              summary: tender.summary,
              category: tender.category,
              country_code: tender.country_code,
              closes_at: tender.closes_at,
            },
            offerings.map((o) => ({
              name: o.name,
              category: o.category,
              target_countries: asStringArray(o.target_countries),
            })),
          );
          const row = await trx
            .insertInto('tender_bid_assessments')
            .values({
              tenant_id: ctx.tenantId,
              tender_id: tender.id,
              recommendation: result.recommendation,
              fit_score: result.fit_score,
              factors: JSON.stringify(result.factors),
              missing_information: JSON.stringify(result.missing_information),
              note: result.note,
              created_by: ctx.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'tender.bid_assessed',
            entityType: 'tender',
            entityId: tender.id,
            correlationId: ctx.correlationId,
            metadata: {
              recommendation: result.recommendation,
              fit_score: result.fit_score,
            },
          });
          return {
            id: row.id,
            tender_id: row.tender_id,
            recommendation: row.recommendation as 'bid' | 'no_bid' | 'review',
            fit_score: row.fit_score,
            factors: parseFactors(row.factors),
            missing_information: asStringArray(row.missing_information),
            note: row.note,
            human_decision: row.human_decision as 'bid' | 'no_bid' | 'defer' | null,
            decided_at: row.decided_at?.toISOString() ?? null,
            created_at: row.created_at.toISOString(),
          };
        });
        return reply.status(201).send(assessment);
      },
    );

    app.patch(
      '/tender-bid-assessments/:id',
      {
        schema: {
          tags: ['tenders'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            human_decision: z.enum(['bid', 'no_bid', 'defer']),
          }),
          response: { 200: Assessment },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'tender.decide');
        return withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'tenders');
          const existing = await trx
            .selectFrom('tender_bid_assessments')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!existing) throw notFound('Bid assessment');
          const row = await trx
            .updateTable('tender_bid_assessments')
            .set({
              human_decision: request.body.human_decision,
              decided_by: ctx.userId,
              decided_at: new Date(),
            })
            .where('id', '=', existing.id)
            .where('tenant_id', '=', ctx.tenantId)
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'tender.human_decision',
            entityType: 'tender_bid_assessment',
            entityId: row.id,
            correlationId: ctx.correlationId,
            metadata: { human_decision: request.body.human_decision },
          });
          return {
            id: row.id,
            tender_id: row.tender_id,
            recommendation: row.recommendation as 'bid' | 'no_bid' | 'review',
            fit_score: row.fit_score,
            factors: parseFactors(row.factors),
            missing_information: asStringArray(row.missing_information),
            note: row.note,
            human_decision: row.human_decision as 'bid' | 'no_bid' | 'defer' | null,
            decided_at: row.decided_at?.toISOString() ?? null,
            created_at: row.created_at.toISOString(),
          };
        });
      },
    );

    app.get(
      '/competitors',
      {
        schema: {
          tags: ['competitors'],
          response: { 200: z.object({ data: z.array(Competitor), note: z.string() }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'competitor.read');
        return withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'competitors');
          const rows = await trx
            .selectFrom('competitors')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('status', '=', 'watching')
            .orderBy('created_at', 'desc')
            .execute();
          return {
            note: 'Competitor watchlist. Battlecards must not fabricate certifications.',
            data: rows.map((r) => ({
              id: r.id,
              name: r.name,
              domain: r.domain,
              notes: r.notes,
              status: r.status as 'watching' | 'archived',
              created_at: r.created_at.toISOString(),
            })),
          };
        });
      },
    );

    app.post(
      '/competitors',
      {
        schema: {
          tags: ['competitors'],
          body: z.object({
            name: z.string().min(1).max(200),
            domain: z.string().min(1).max(253).nullable().optional(),
            notes: z.string().max(2000).nullable().optional(),
          }),
          response: { 201: Competitor },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'competitor.write');
        const row = await withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'competitors');
          const inserted = await trx
            .insertInto('competitors')
            .values({
              tenant_id: ctx.tenantId,
              name: request.body.name,
              domain: request.body.domain ?? null,
              notes: request.body.notes ?? null,
              status: 'watching',
              created_by: ctx.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'competitor.created',
            entityType: 'competitor',
            entityId: inserted.id,
            correlationId: ctx.correlationId,
            metadata: { name: inserted.name },
          });
          return inserted;
        });
        return reply.status(201).send({
          id: row.id,
          name: row.name,
          domain: row.domain,
          notes: row.notes,
          status: row.status as 'watching' | 'archived',
          created_at: row.created_at.toISOString(),
        });
      },
    );

    app.post(
      '/competitors/:id/battlecards',
      {
        schema: {
          tags: ['competitors'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            strengths: z.string().min(1).max(4000),
            weaknesses: z.string().min(1).max(4000),
            landmines: z.string().max(4000).optional().default(''),
            our_differentiators: z.string().min(1).max(4000),
            certifications_note: z
              .string()
              .min(1)
              .max(1000)
              .optional()
              .default('No certifications asserted without evidence.'),
            evidence_ids: z.array(z.uuid()).max(20).optional().default([]),
            claim_type: z
              .enum(['source_fact', 'provider_fact', 'model_inference', 'user_assertion'])
              .optional()
              .default('user_assertion'),
          }),
          response: { 201: Battlecard },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'competitor.write');
        const card = await withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'competitors');
          const competitor = await trx
            .selectFrom('competitors')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!competitor) throw notFound('Competitor');
          if (
            (request.body.claim_type === 'source_fact' ||
              request.body.claim_type === 'provider_fact') &&
            request.body.evidence_ids.length === 0
          ) {
            throw new AppError(
              'VALIDATION_ERROR',
              'Sourced battlecard claims require evidence_ids. Certifications must not be fabricated.',
            );
          }
          if (request.body.evidence_ids.length) {
            const found = await trx
              .selectFrom('evidence_records')
              .select('id')
              .where('tenant_id', '=', ctx.tenantId)
              .where('id', 'in', request.body.evidence_ids)
              .execute();
            if (found.length !== request.body.evidence_ids.length) {
              throw new AppError('VALIDATION_ERROR', 'One or more evidence_ids are invalid.');
            }
          }
          const latest = await trx
            .selectFrom('competitor_battlecards')
            .select('version')
            .where('tenant_id', '=', ctx.tenantId)
            .where('competitor_id', '=', competitor.id)
            .orderBy('version', 'desc')
            .limit(1)
            .executeTakeFirst();
          const version = (latest?.version ?? 0) + 1;
          const row = await trx
            .insertInto('competitor_battlecards')
            .values({
              tenant_id: ctx.tenantId,
              competitor_id: competitor.id,
              version,
              strengths: request.body.strengths,
              weaknesses: request.body.weaknesses,
              landmines: request.body.landmines,
              our_differentiators: request.body.our_differentiators,
              certifications_note: request.body.certifications_note,
              evidence_ids: JSON.stringify(request.body.evidence_ids),
              claim_type: request.body.claim_type,
              created_by: ctx.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'competitor.battlecard_created',
            entityType: 'competitor',
            entityId: competitor.id,
            correlationId: ctx.correlationId,
            metadata: { version },
          });
          return {
            id: row.id,
            competitor_id: row.competitor_id,
            version: row.version,
            strengths: row.strengths,
            weaknesses: row.weaknesses,
            landmines: row.landmines,
            our_differentiators: row.our_differentiators,
            certifications_note: row.certifications_note,
            evidence_ids: asStringArray(row.evidence_ids),
            claim_type: row.claim_type,
            created_at: row.created_at.toISOString(),
          };
        });
        return reply.status(201).send(card);
      },
    );

    app.get(
      '/competitors/:id/battlecards',
      {
        schema: {
          tags: ['competitors'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ data: z.array(Battlecard), note: z.string() }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'competitor.read');
        return withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'competitors');
          const competitor = await trx
            .selectFrom('competitors')
            .select('id')
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!competitor) throw notFound('Competitor');
          const rows = await trx
            .selectFrom('competitor_battlecards')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('competitor_id', '=', competitor.id)
            .orderBy('version', 'desc')
            .execute();
          return {
            note: 'Versioned battlecards. Certifications require evidence.',
            data: rows.map((row) => ({
              id: row.id,
              competitor_id: row.competitor_id,
              version: row.version,
              strengths: row.strengths,
              weaknesses: row.weaknesses,
              landmines: row.landmines,
              our_differentiators: row.our_differentiators,
              certifications_note: row.certifications_note,
              evidence_ids: asStringArray(row.evidence_ids),
              claim_type: row.claim_type,
              created_at: row.created_at.toISOString(),
            })),
          };
        });
      },
    );
  };
