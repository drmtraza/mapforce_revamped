import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { personaFromTitle } from '../ai/taxonomy.ts';
import { recordAudit } from '../audit/service.ts';
import { loadCompany } from '../companies/routes.ts';
import { isFlagEnabled } from '../rollout/flags.ts';
import { isDomainSuppressed } from '../suppressions/check.ts';
import { MATCHING_VERSION, matchOffering, rankMatches, type OfferingForMatch } from './match.ts';

const Category = z.enum([
  'product',
  'software',
  'saas',
  'cloud',
  'cybersecurity',
  'ai_automation',
  'professional_services',
  'consulting',
  'training',
  'distribution',
  'custom_enterprise',
  'other',
]);

const PricingModel = z.enum([
  'unspecified',
  'subscription',
  'one_time',
  'usage',
  'fixed_fee',
  'time_materials',
  'reseller',
]);

const stringList = z.array(z.string().trim().min(1).max(80)).max(50);

const Offering = z.object({
  id: z.string(),
  name: z.string(),
  category: Category,
  description: z.string(),
  business_problem: z.string(),
  target_industries: z.array(z.string()),
  target_countries: z.array(z.string()),
  employee_bands: z.array(z.string()),
  target_personas: z.array(z.string()),
  pricing_model: PricingModel,
  price_range_note: z.string().nullable(),
  requirements_note: z.string().nullable(),
  status: z.enum(['draft', 'active', 'archived']),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

const Document = z.object({
  id: z.string(),
  offering_id: z.string(),
  title: z.string(),
  doc_kind: z.enum(['brochure', 'case_study', 'spec', 'pricing', 'certification', 'other']),
  source_uri: z.string(),
  notes: z.string().nullable(),
  created_at: z.string(),
});

const MatchResult = z.object({
  id: z.string(),
  offering_id: z.string(),
  offering_name: z.string(),
  offering_category: z.string(),
  match_score: z.number(),
  commercial_potential: z.number(),
  confidence: z.enum(['low', 'medium', 'high']),
  eligible: z.boolean(),
  suppression_override: z.boolean(),
  factors: z.array(
    z.object({
      key: z.string(),
      value: z.number(),
      max: z.number(),
      rationale: z.string(),
    }),
  ),
  missing_information: z.array(z.string()),
  recommended_approach: z.string(),
  recommended_next_action: z.string(),
  note: z.string(),
});

function asStringArray(raw: unknown): string[] {
  if (typeof raw === 'string') {
    try {
      return asStringArray(JSON.parse(raw) as unknown);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw === 'string') {
    try {
      return parseJsonArray<T>(JSON.parse(raw) as unknown);
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? (raw as T[]) : [];
}

function mapOffering(row: {
  id: string;
  name: string;
  category: string;
  description: string;
  business_problem: string;
  target_industries: unknown;
  target_countries: unknown;
  employee_bands: unknown;
  target_personas: unknown;
  pricing_model: string;
  price_range_note: string | null;
  requirements_note: string | null;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    category: row.category as z.infer<typeof Category>,
    description: row.description,
    business_problem: row.business_problem,
    target_industries: asStringArray(row.target_industries),
    target_countries: asStringArray(row.target_countries),
    employee_bands: asStringArray(row.employee_bands),
    target_personas: asStringArray(row.target_personas),
    pricing_model: row.pricing_model as z.infer<typeof PricingModel>,
    price_range_note: row.price_range_note,
    requirements_note: row.requirements_note,
    status: row.status as 'draft' | 'active' | 'archived',
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function requireCatalogueFlag(
  trx: Parameters<typeof isFlagEnabled>[0],
  tenantId: string,
  key: 'product_catalogue' | 'opportunity_matching',
) {
  if (!(await isFlagEnabled(trx, tenantId, key))) {
    throw new AppError('FEATURE_DISABLED', `Feature flag "${key}" is disabled for this workspace.`);
  }
}

export const catalogueRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/product-offerings',
      {
        schema: {
          tags: ['catalogue'],
          querystring: z.object({
            status: z.enum(['draft', 'active', 'archived']).optional(),
          }),
          response: { 200: z.object({ data: z.array(Offering), note: z.string() }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'catalogue.read');
        return withContext(db, ctx, async (trx) => {
          await requireCatalogueFlag(trx, ctx.tenantId, 'product_catalogue');
          let q = trx
            .selectFrom('product_offerings')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .orderBy('updated_at', 'desc')
            .limit(200);
          if (request.query.status) q = q.where('status', '=', request.query.status);
          const rows = await q.execute();
          return {
            data: rows.map(mapOffering),
            note: 'Catalogue entries are workspace-authored. AI must not invent capabilities or prices.',
          };
        });
      },
    );

    app.post(
      '/product-offerings',
      {
        schema: {
          tags: ['catalogue'],
          body: z.object({
            name: z.string().trim().min(1).max(200),
            category: Category,
            description: z.string().trim().min(1).max(4000),
            business_problem: z.string().trim().min(1).max(2000),
            target_industries: stringList.default([]),
            target_countries: stringList.default([]),
            employee_bands: stringList.default([]),
            target_personas: stringList.default([]),
            pricing_model: PricingModel.default('unspecified'),
            price_range_note: z.string().trim().max(500).nullable().optional(),
            requirements_note: z.string().trim().max(2000).nullable().optional(),
            status: z.enum(['draft', 'active', 'archived']).default('active'),
          }),
          response: { 201: Offering },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'catalogue.write');
        const row = await withContext(db, ctx, async (trx) => {
          await requireCatalogueFlag(trx, ctx.tenantId, 'product_catalogue');
          const created = await trx
            .insertInto('product_offerings')
            .values({
              tenant_id: ctx.tenantId,
              name: request.body.name,
              category: request.body.category,
              description: request.body.description,
              business_problem: request.body.business_problem,
              target_industries: JSON.stringify(request.body.target_industries),
              target_countries: JSON.stringify(request.body.target_countries),
              employee_bands: JSON.stringify(request.body.employee_bands),
              target_personas: JSON.stringify(request.body.target_personas),
              pricing_model: request.body.pricing_model,
              price_range_note: request.body.price_range_note ?? null,
              requirements_note: request.body.requirements_note ?? null,
              status: request.body.status,
              created_by: ctx.userId,
              updated_by: ctx.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'catalogue.offering_created',
            entityType: 'product_offering',
            entityId: created.id,
            correlationId: ctx.correlationId,
            metadata: { name: created.name, category: created.category },
          });
          return created;
        });
        return reply.status(201).send(mapOffering(row));
      },
    );

    app.patch(
      '/product-offerings/:id',
      {
        schema: {
          tags: ['catalogue'],
          params: z.object({ id: z.uuid() }),
          body: z
            .object({
              name: z.string().trim().min(1).max(200).optional(),
              description: z.string().trim().min(1).max(4000).optional(),
              business_problem: z.string().trim().min(1).max(2000).optional(),
              target_industries: stringList.optional(),
              target_countries: stringList.optional(),
              employee_bands: stringList.optional(),
              target_personas: stringList.optional(),
              pricing_model: PricingModel.optional(),
              price_range_note: z.string().trim().max(500).nullable().optional(),
              requirements_note: z.string().trim().max(2000).nullable().optional(),
              status: z.enum(['draft', 'active', 'archived']).optional(),
            })
            .strict(),
          response: { 200: Offering },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'catalogue.write');
        return withContext(db, ctx, async (trx) => {
          await requireCatalogueFlag(trx, ctx.tenantId, 'product_catalogue');
          const current = await trx
            .selectFrom('product_offerings')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!current) throw notFound('Product offering');
          const patch = {
            ...(request.body.name !== undefined ? { name: request.body.name } : {}),
            ...(request.body.description !== undefined
              ? { description: request.body.description }
              : {}),
            ...(request.body.business_problem !== undefined
              ? { business_problem: request.body.business_problem }
              : {}),
            ...(request.body.target_industries !== undefined
              ? { target_industries: JSON.stringify(request.body.target_industries) }
              : {}),
            ...(request.body.target_countries !== undefined
              ? { target_countries: JSON.stringify(request.body.target_countries) }
              : {}),
            ...(request.body.employee_bands !== undefined
              ? { employee_bands: JSON.stringify(request.body.employee_bands) }
              : {}),
            ...(request.body.target_personas !== undefined
              ? { target_personas: JSON.stringify(request.body.target_personas) }
              : {}),
            ...(request.body.pricing_model !== undefined
              ? { pricing_model: request.body.pricing_model }
              : {}),
            ...(request.body.price_range_note !== undefined
              ? { price_range_note: request.body.price_range_note }
              : {}),
            ...(request.body.requirements_note !== undefined
              ? { requirements_note: request.body.requirements_note }
              : {}),
            ...(request.body.status !== undefined ? { status: request.body.status } : {}),
            updated_by: ctx.userId,
          };
          const updated = await trx
            .updateTable('product_offerings')
            .set(patch)
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .returningAll()
            .executeTakeFirst();
          if (!updated) throw notFound('Product offering');
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'catalogue.offering_updated',
            entityType: 'product_offering',
            entityId: updated.id,
            correlationId: ctx.correlationId,
          });
          return mapOffering(updated);
        });
      },
    );

    app.post(
      '/product-offerings/:id/documents',
      {
        schema: {
          tags: ['catalogue'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            title: z.string().trim().min(1).max(200),
            doc_kind: z.enum([
              'brochure',
              'case_study',
              'spec',
              'pricing',
              'certification',
              'other',
            ]),
            source_uri: z.string().trim().min(1).max(2000),
            notes: z.string().trim().max(2000).nullable().optional(),
          }),
          response: { 201: Document },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'catalogue.write');
        const row = await withContext(db, ctx, async (trx) => {
          await requireCatalogueFlag(trx, ctx.tenantId, 'product_catalogue');
          const offering = await trx
            .selectFrom('product_offerings')
            .select('id')
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!offering) throw notFound('Product offering');
          const created = await trx
            .insertInto('product_documents')
            .values({
              tenant_id: ctx.tenantId,
              offering_id: offering.id,
              title: request.body.title,
              doc_kind: request.body.doc_kind,
              source_uri: request.body.source_uri,
              notes: request.body.notes ?? null,
              created_by: ctx.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'catalogue.document_added',
            entityType: 'product_document',
            entityId: created.id,
            correlationId: ctx.correlationId,
          });
          return created;
        });
        return reply.status(201).send({
          id: row.id,
          offering_id: row.offering_id,
          title: row.title,
          doc_kind: row.doc_kind,
          source_uri: row.source_uri,
          notes: row.notes,
          created_at: row.created_at.toISOString(),
        });
      },
    );

    app.get(
      '/product-offerings/:id/documents',
      {
        schema: {
          tags: ['catalogue'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ data: z.array(Document) }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'catalogue.read');
        return withContext(db, ctx, async (trx) => {
          await requireCatalogueFlag(trx, ctx.tenantId, 'product_catalogue');
          const offering = await trx
            .selectFrom('product_offerings')
            .select('id')
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!offering) throw notFound('Product offering');
          const rows = await trx
            .selectFrom('product_documents')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('offering_id', '=', offering.id)
            .orderBy('created_at', 'desc')
            .limit(100)
            .execute();
          return {
            data: rows.map((r) => ({
              id: r.id,
              offering_id: r.offering_id,
              title: r.title,
              doc_kind: r.doc_kind,
              source_uri: r.source_uri,
              notes: r.notes,
              created_at: r.created_at.toISOString(),
            })),
          };
        });
      },
    );

    app.post(
      '/companies/:id/opportunity-matches',
      {
        schema: {
          tags: ['catalogue'],
          params: z.object({ id: z.uuid() }),
          response: {
            201: z.object({
              run_id: z.string(),
              matching_version: z.string(),
              account_score_note: z.string(),
              data: z.array(MatchResult),
            }),
          },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'match.run');
        const result = await withContext(db, ctx, async (trx) => {
          await requireCatalogueFlag(trx, ctx.tenantId, 'opportunity_matching');
          const company = await loadCompany(trx, ctx.tenantId, request.params.id);
          const suppressed = await isDomainSuppressed(trx, ctx.tenantId, company.primary_domain);
          const offerings = await trx
            .selectFrom('product_offerings')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('status', '=', 'active')
            .orderBy('updated_at', 'desc')
            .limit(100)
            .execute();
          if (offerings.length === 0) {
            throw new AppError(
              'INVALID_STATE',
              'Create at least one active product offering before matching.',
            );
          }
          const roles = await trx
            .selectFrom('employment_roles')
            .select(['title'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', company.id)
            .limit(200)
            .execute();
          const personas = [
            ...new Set(roles.map((r) => personaFromTitle(r.title)).filter((p) => p !== 'unknown')),
          ];
          const signals = await trx
            .selectFrom('intent_signals')
            .select(['signal_type', 'implies_budget', 'observed_at'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', company.id)
            .orderBy('observed_at', 'desc')
            .limit(50)
            .execute();
          const evidence = await trx
            .selectFrom('evidence_records')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', company.id)
            .executeTakeFirst();
          const evidenceCount = Number(evidence?.n ?? 0);

          const run = await trx
            .insertInto('opportunity_match_runs')
            .values({
              tenant_id: ctx.tenantId,
              company_id: company.id,
              matching_version: MATCHING_VERSION,
              created_by: ctx.userId,
            })
            .returning(['id'])
            .executeTakeFirstOrThrow();

          const computed = rankMatches(
            offerings.map((o) => {
              const offering: OfferingForMatch = {
                id: o.id,
                name: o.name,
                category: o.category,
                business_problem: o.business_problem,
                target_industries: asStringArray(o.target_industries),
                target_countries: asStringArray(o.target_countries),
                employee_bands: asStringArray(o.employee_bands),
                target_personas: asStringArray(o.target_personas),
                pricing_model: o.pricing_model,
                price_range_note: o.price_range_note,
              };
              return matchOffering({
                company: {
                  id: company.id,
                  domain: company.primary_domain,
                  industry: company.industry,
                  country_code: company.country_code,
                  employee_band: company.employee_band,
                  description: company.description,
                },
                offering,
                people_personas: personas,
                signals: signals.map((s) => ({
                  signal_type: s.signal_type,
                  implies_budget: s.implies_budget,
                  observed_at: s.observed_at.toISOString(),
                })),
                evidence_count: evidenceCount,
                suppressed,
              });
            }),
          );

          const nameById = new Map(
            offerings.map((o) => [o.id, { name: o.name, category: o.category }]),
          );
          const inserted = [];
          for (const m of computed) {
            const row = await trx
              .insertInto('opportunity_match_results')
              .values({
                tenant_id: ctx.tenantId,
                run_id: run.id,
                company_id: company.id,
                offering_id: m.offering_id,
                match_score: m.match_score,
                commercial_potential: m.commercial_potential,
                confidence: m.confidence,
                eligible: m.eligible,
                suppression_override: m.suppression_override,
                factors: JSON.stringify(m.factors),
                missing_information: JSON.stringify(m.missing_information),
                recommended_approach: m.recommended_approach,
                recommended_next_action: m.recommended_next_action,
                note: m.note,
              })
              .returning(['id'])
              .executeTakeFirstOrThrow();
            const meta = nameById.get(m.offering_id)!;
            inserted.push({
              id: row.id,
              offering_id: m.offering_id,
              offering_name: meta.name,
              offering_category: meta.category,
              match_score: m.match_score,
              commercial_potential: m.commercial_potential,
              confidence: m.confidence,
              eligible: m.eligible,
              suppression_override: m.suppression_override,
              factors: m.factors,
              missing_information: m.missing_information,
              recommended_approach: m.recommended_approach,
              recommended_next_action: m.recommended_next_action,
              note: m.note,
            });
          }

          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'catalogue.match_run',
            entityType: 'company',
            entityId: company.id,
            correlationId: ctx.correlationId,
            metadata: { run_id: run.id, results: inserted.length },
          });

          return {
            run_id: run.id,
            matching_version: MATCHING_VERSION,
            account_score_note:
              'These match_score values are product-fit heuristics (product-match/1.0.0), not ICP account scores (icp-explainable/1.0.0) and not buying intent.',
            data: inserted,
          };
        });
        return reply.status(201).send(result);
      },
    );

    app.get(
      '/companies/:id/opportunity-matches',
      {
        schema: {
          tags: ['catalogue'],
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              run_id: z.string().nullable(),
              matching_version: z.string().nullable(),
              account_score_note: z.string(),
              data: z.array(MatchResult),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'catalogue.read');
        return withContext(db, ctx, async (trx) => {
          await requireCatalogueFlag(trx, ctx.tenantId, 'opportunity_matching');
          await loadCompany(trx, ctx.tenantId, request.params.id);
          const run = await trx
            .selectFrom('opportunity_match_runs')
            .select(['id', 'matching_version'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', request.params.id)
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst();
          if (!run) {
            return {
              run_id: null,
              matching_version: null,
              account_score_note:
                'No match run yet. Product match scores are distinct from ICP account scores.',
              data: [],
            };
          }
          const rows = await trx
            .selectFrom('opportunity_match_results as r')
            .innerJoin('product_offerings as o', 'o.id', 'r.offering_id')
            .select([
              'r.id',
              'r.offering_id',
              'o.name as offering_name',
              'o.category as offering_category',
              'r.match_score',
              'r.commercial_potential',
              'r.confidence',
              'r.eligible',
              'r.suppression_override',
              'r.factors',
              'r.missing_information',
              'r.recommended_approach',
              'r.recommended_next_action',
              'r.note',
            ])
            .where('r.tenant_id', '=', ctx.tenantId)
            .where('r.run_id', '=', run.id)
            .orderBy('r.match_score', 'desc')
            .limit(100)
            .execute();
          return {
            run_id: run.id,
            matching_version: run.matching_version,
            account_score_note:
              'These match_score values are product-fit heuristics (product-match/1.0.0), not ICP account scores (icp-explainable/1.0.0) and not buying intent.',
            data: rows.map((r) => ({
              id: r.id,
              offering_id: r.offering_id,
              offering_name: r.offering_name,
              offering_category: r.offering_category,
              match_score: r.match_score,
              commercial_potential: r.commercial_potential,
              confidence: r.confidence,
              eligible: r.eligible,
              suppression_override: r.suppression_override,
              factors: parseJsonArray<{
                key: string;
                value: number;
                max: number;
                rationale: string;
              }>(r.factors),
              missing_information: asStringArray(r.missing_information),
              recommended_approach: r.recommended_approach,
              recommended_next_action: r.recommended_next_action,
              note: r.note,
            })),
          };
        });
      },
    );
  };
