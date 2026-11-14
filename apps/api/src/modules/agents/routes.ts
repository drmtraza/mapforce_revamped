import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql, withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { resolveTenantLimits } from '../budgets/service.ts';
import { loadCompany } from '../companies/routes.ts';
import { assertCapability } from '../ops/gate.ts';
import { isFlagEnabled } from '../rollout/flags.ts';
import { gatewayProviderLabel } from './gateway.ts';
import { ORCHESTRATOR_VERSION, runAccountIntelligence, type ClaimType } from './orchestrator.ts';

const Claim = z.object({
  key: z.string(),
  text: z.string(),
  claim_type: z.enum(['source_fact', 'provider_fact', 'model_inference', 'user_assertion']),
  evidence_ids: z.array(z.string()),
  agent: z.enum(['research', 'signals', 'matching', 'evidence_check']),
});

const Report = z.object({
  id: z.uuid(),
  company_id: z.uuid(),
  status: z.enum(['draft_for_review', 'accepted', 'dismissed', 'quarantined']),
  orchestrator_version: z.string(),
  provider: z.string(),
  gateway_provider: z.string(),
  summary: z.string(),
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      claims: z.array(Claim),
    }),
  ),
  quarantined_claims: z.array(Claim),
  agent_trace: z.array(
    z.object({
      agent: z.string(),
      ok: z.boolean(),
      detail: z.string(),
      duration_ms: z.number().int(),
    }),
  ),
  token_count: z.number().int(),
  duration_ms: z.number().int(),
  review_note: z.string().nullable(),
  created_at: z.string(),
  note: z.string(),
});

type ReportDto = z.infer<typeof Report>;

function parseSections(value: unknown): ReportDto['sections'] {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  return Report.shape.sections.parse(raw);
}

function parseClaims(value: unknown): ReportDto['quarantined_claims'] {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  return Report.shape.quarantined_claims.parse(raw);
}

function parseTrace(value: unknown): ReportDto['agent_trace'] {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  return Report.shape.agent_trace.parse(raw);
}

function toReportDto(
  row: {
    id: string;
    company_id: string;
    status: string;
    orchestrator_version: string;
    provider: string;
    summary: string;
    sections: unknown;
    quarantined_claims: unknown;
    agent_trace: unknown;
    token_count: number;
    duration_ms: number;
    review_note: string | null;
    created_at: Date;
  },
  gateway: string,
  note: string,
): ReportDto {
  return {
    id: row.id,
    company_id: row.company_id,
    status: row.status as ReportDto['status'],
    orchestrator_version: row.orchestrator_version,
    provider: row.provider,
    gateway_provider: gateway,
    summary: row.summary,
    sections: parseSections(row.sections),
    quarantined_claims: parseClaims(row.quarantined_claims),
    agent_trace: parseTrace(row.agent_trace),
    token_count: row.token_count,
    duration_ms: row.duration_ms,
    review_note: row.review_note,
    created_at: row.created_at.toISOString(),
    note,
  };
}

export const agentRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, config } = deps;

    app.post(
      '/companies/:id/account-intelligence',
      {
        schema: {
          tags: ['agents'],
          params: z.object({ id: z.uuid() }),
          response: { 201: Report },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'intel.generate');
        const report = await withContext(db, ctx, async (trx) => {
          if (!(await isFlagEnabled(trx, ctx.tenantId, 'account_intelligence'))) {
            throw new AppError(
              'FEATURE_DISABLED',
              'Feature flag "account_intelligence" is disabled for this workspace.',
            );
          }
          await assertCapability(trx, ctx.tenantId, config, 'ai', 'AI');
          const limits = await resolveTenantLimits(trx, ctx.tenantId, config);
          const since = new Date(Date.now() - 86_400_000);
          const used = await trx
            .selectFrom('account_intelligence_reports')
            .select(sql<string>`count(*)`.as('n'))
            .where('tenant_id', '=', ctx.tenantId)
            .where('created_at', '>=', since)
            .executeTakeFirst();
          if (Number(used?.n ?? 0) >= limits.ai) {
            throw new AppError(
              'QUOTA_EXCEEDED',
              'Daily AI / account-intelligence budget exhausted for this workspace.',
            );
          }

          const company = await loadCompany(trx, ctx.tenantId, request.params.id);
          const evidence = await trx
            .selectFrom('evidence_records')
            .select(['id', 'source_registry_id', 'excerpt'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', company.id)
            .orderBy('fetched_at', 'desc')
            .limit(40)
            .execute();
          const people = await trx
            .selectFrom('people as p')
            .innerJoin('person_company_links as l', 'l.person_id', 'p.id')
            .select(['p.id', 'p.canonical_name'])
            .where('l.tenant_id', '=', ctx.tenantId)
            .where('l.company_id', '=', company.id)
            .where('p.merged_into_id', 'is', null)
            .limit(30)
            .execute();
          const roles = await trx
            .selectFrom('employment_roles')
            .select(['person_id', 'title'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', company.id)
            .limit(100)
            .execute();
          const titleByPerson = new Map(roles.map((r) => [r.person_id, r.title]));
          const signals = await trx
            .selectFrom('intent_signals')
            .select(['id', 'signal_type', 'title', 'summary', 'claim_type'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', company.id)
            .orderBy('observed_at', 'desc')
            .limit(30)
            .execute();
          const signalIds = signals.map((s) => s.id);
          const signalEvidence =
            signalIds.length === 0
              ? []
              : await trx
                  .selectFrom('signal_evidence')
                  .select(['signal_id', 'evidence_record_id'])
                  .where('tenant_id', '=', ctx.tenantId)
                  .where('signal_id', 'in', signalIds)
                  .execute();
          const evBySignal = new Map<string, string[]>();
          for (const se of signalEvidence) {
            const list = evBySignal.get(se.signal_id) ?? [];
            list.push(se.evidence_record_id);
            evBySignal.set(se.signal_id, list);
          }
          const personIds = people.map((p) => p.id);
          const personEvidence =
            personIds.length === 0
              ? []
              : await trx
                  .selectFrom('claims as c')
                  .innerJoin('claim_evidence as ce', 'ce.claim_id', 'c.id')
                  .select(['c.subject_id', 'ce.evidence_record_id'])
                  .where('c.tenant_id', '=', ctx.tenantId)
                  .where('c.subject_type', '=', 'person')
                  .where('c.subject_id', 'in', personIds)
                  .limit(200)
                  .execute();
          const evByPerson = new Map<string, string[]>();
          for (const pe of personEvidence) {
            const list = evByPerson.get(pe.subject_id) ?? [];
            list.push(pe.evidence_record_id);
            evByPerson.set(pe.subject_id, list);
          }

          const matches = await trx
            .selectFrom('opportunity_match_results as r')
            .innerJoin('product_offerings as o', 'o.id', 'r.offering_id')
            .select(['o.name', 'r.match_score', 'r.note', 'r.eligible'])
            .where('r.tenant_id', '=', ctx.tenantId)
            .where('r.company_id', '=', company.id)
            .orderBy('r.created_at', 'desc')
            .limit(20)
            .execute();

          const started = Date.now();
          const result = runAccountIntelligence({
            company: {
              id: company.id,
              name: company.canonical_name,
              domain: company.primary_domain,
              industry: company.industry,
              country_code: company.country_code,
              description: company.description,
            },
            evidence: evidence.map((e) => ({
              id: e.id,
              source_key: e.source_registry_id,
              excerpt: e.excerpt ?? '',
            })),
            people: people.map((p) => ({
              id: p.id,
              display_name: p.canonical_name,
              title: titleByPerson.get(p.id) ?? null,
              evidence_ids: evByPerson.get(p.id) ?? [],
            })),
            signals: signals.map((s) => ({
              id: s.id,
              signal_type: s.signal_type,
              title: s.title,
              summary: s.summary,
              claim_type: s.claim_type as ClaimType,
              evidence_ids: evBySignal.get(s.id) ?? [],
            })),
            matches: matches.map((m) => ({
              offering_name: m.name,
              match_score: m.match_score,
              note: m.note,
              eligible: m.eligible,
            })),
          });
          const durationMs = Date.now() - started;
          const gateway = gatewayProviderLabel(config);

          const row = await trx
            .insertInto('account_intelligence_reports')
            .values({
              tenant_id: ctx.tenantId,
              company_id: company.id,
              status: result.status,
              orchestrator_version: ORCHESTRATOR_VERSION,
              provider: result.provider,
              summary: result.summary,
              sections: JSON.stringify(result.sections),
              quarantined_claims: JSON.stringify(result.quarantined_claims),
              agent_trace: JSON.stringify(result.agent_trace),
              token_count: 0,
              duration_ms: durationMs,
              created_by: ctx.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'intel.report_generated',
            entityType: 'company',
            entityId: company.id,
            correlationId: ctx.correlationId,
            metadata: {
              report_id: row.id,
              status: row.status,
              quarantined: result.quarantined_claims.length,
              gateway_provider: gateway,
            },
          });

          return toReportDto(
            row,
            gateway,
            'Draft for human review. Not written to CRM. Not buying intent.',
          );
        });
        return reply.status(201).send(report);
      },
    );

    app.get(
      '/companies/:id/account-intelligence',
      {
        schema: {
          tags: ['agents'],
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              data: z.array(Report),
              note: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'intel.read');
        return withContext(db, ctx, async (trx) => {
          if (!(await isFlagEnabled(trx, ctx.tenantId, 'account_intelligence'))) {
            throw new AppError(
              'FEATURE_DISABLED',
              'Feature flag "account_intelligence" is disabled for this workspace.',
            );
          }
          await loadCompany(trx, ctx.tenantId, request.params.id);
          const gateway = gatewayProviderLabel(config);
          const rows = await trx
            .selectFrom('account_intelligence_reports')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', request.params.id)
            .orderBy('created_at', 'desc')
            .limit(10)
            .execute();
          return {
            note: 'Latest account intelligence drafts. Accept/dismiss keeps CRM unchanged until a later phase writes with explicit approval.',
            data: rows.map((row) =>
              toReportDto(
                row,
                gateway,
                'Draft for human review. Not written to CRM. Not buying intent.',
              ),
            ),
          };
        });
      },
    );

    app.patch(
      '/account-intelligence/:id',
      {
        schema: {
          tags: ['agents'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            status: z.enum(['accepted', 'dismissed']),
            review_note: z.string().max(2000).optional(),
          }),
          response: { 200: Report },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'intel.review');
        return withContext(db, ctx, async (trx) => {
          if (!(await isFlagEnabled(trx, ctx.tenantId, 'account_intelligence'))) {
            throw new AppError(
              'FEATURE_DISABLED',
              'Feature flag "account_intelligence" is disabled for this workspace.',
            );
          }
          const existing = await trx
            .selectFrom('account_intelligence_reports')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!existing) throw notFound('Report');
          const row = await trx
            .updateTable('account_intelligence_reports')
            .set({
              status: request.body.status,
              review_note: request.body.review_note ?? existing.review_note,
              reviewed_by: ctx.userId,
              reviewed_at: new Date(),
            })
            .where('id', '=', existing.id)
            .where('tenant_id', '=', ctx.tenantId)
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'intel.report_reviewed',
            entityType: 'account_intelligence_report',
            entityId: row.id,
            correlationId: ctx.correlationId,
            metadata: { status: request.body.status },
          });
          return toReportDto(row, gatewayProviderLabel(config), 'Review recorded. CRM unchanged.');
        });
      },
    );
  };
