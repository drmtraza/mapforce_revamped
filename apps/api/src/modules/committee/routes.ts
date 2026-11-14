import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { loadCompany } from '../companies/routes.ts';
import { isFlagEnabled } from '../rollout/flags.ts';
import { computeCoverage, parseEvidenceIds, type CommitteeRole } from './coverage.ts';

const CommitteeRoleEnum = z.enum([
  'economic_buyer',
  'champion',
  'technical_evaluator',
  'procurement',
  'legal',
  'end_user',
  'blocker',
  'coach',
  'budget_owner',
  'influencer',
  'unknown',
]);

const ClaimType = z.enum(['source_fact', 'provider_fact', 'model_inference', 'user_assertion']);

const Member = z.object({
  id: z.uuid(),
  company_id: z.uuid(),
  person_id: z.uuid(),
  person_name: z.string().nullable(),
  person_title: z.string().nullable(),
  committee_role: CommitteeRoleEnum,
  claim_type: ClaimType,
  confidence: z.number(),
  rationale: z.string(),
  evidence_ids: z.array(z.string()),
  status: z.enum(['active', 'dismissed']),
  created_at: z.string(),
});

const Coverage = z.object({
  coverage_score: z.number().int(),
  filled_required: z.array(z.string()),
  missing_required: z.array(z.string()),
  budget_owner_present: z.boolean(),
  budget_owner_grounded: z.boolean(),
  note: z.string(),
});

const Plan = z.object({
  id: z.uuid(),
  company_id: z.uuid(),
  version: z.number().int(),
  status: z.enum(['draft', 'active', 'archived']),
  title: z.string(),
  situation: z.string(),
  objective: z.string(),
  strategy: z.string(),
  risks: z.string(),
  next_steps: z.string(),
  coverage_score: z.number().int(),
  coverage_note: z.string(),
  reporting_note: z.string(),
  assigned_manager_user_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

async function requireFlag(
  trx: Parameters<typeof isFlagEnabled>[0],
  tenantId: string,
  key: 'buying_committee' | 'account_plans',
) {
  if (!(await isFlagEnabled(trx, tenantId, key))) {
    throw new AppError('FEATURE_DISABLED', `Feature flag "${key}" is disabled for this workspace.`);
  }
}

function assertGrounding(
  role: CommitteeRole,
  claimType: z.infer<typeof ClaimType>,
  evidenceIds: string[],
) {
  if (role === 'budget_owner' && evidenceIds.length === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'budget_owner requires at least one evidence_id; authority is never asserted without evidence.',
    );
  }
  if ((claimType === 'source_fact' || claimType === 'provider_fact') && evidenceIds.length === 0) {
    throw new AppError('VALIDATION_ERROR', `${claimType} classifications require evidence_ids.`);
  }
}

async function loadCoverage(
  trx: Parameters<typeof isFlagEnabled>[0],
  tenantId: string,
  companyId: string,
) {
  const rows = await trx
    .selectFrom('buying_committee_members')
    .select(['committee_role', 'status', 'claim_type', 'evidence_ids'])
    .where('tenant_id', '=', tenantId)
    .where('company_id', '=', companyId)
    .execute();
  return computeCoverage(
    rows.map((r) => ({
      committee_role: r.committee_role as CommitteeRole,
      status: r.status as 'active' | 'dismissed',
      claim_type: r.claim_type,
      evidence_ids: parseEvidenceIds(r.evidence_ids),
    })),
  );
}

function toPlan(row: {
  id: string;
  company_id: string;
  version: number;
  status: string;
  title: string;
  situation: string;
  objective: string;
  strategy: string;
  risks: string;
  next_steps: string;
  coverage_score: number;
  coverage_note: string;
  reporting_note: string;
  assigned_manager_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: row.id,
    company_id: row.company_id,
    version: row.version,
    status: row.status as 'draft' | 'active' | 'archived',
    title: row.title,
    situation: row.situation,
    objective: row.objective,
    strategy: row.strategy,
    risks: row.risks,
    next_steps: row.next_steps,
    coverage_score: row.coverage_score,
    coverage_note: row.coverage_note,
    reporting_note: row.reporting_note,
    assigned_manager_user_id: row.assigned_manager_user_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export const committeeRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/companies/:id/buying-committee',
      {
        schema: {
          tags: ['committee'],
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              data: z.array(Member),
              coverage: Coverage,
              note: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'committee.read');
        return withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'buying_committee');
          await loadCompany(trx, ctx.tenantId, request.params.id);
          const rows = await trx
            .selectFrom('buying_committee_members as m')
            .innerJoin('people as p', 'p.id', 'm.person_id')
            .select([
              'm.id',
              'm.company_id',
              'm.person_id',
              'p.canonical_name',
              'm.committee_role',
              'm.claim_type',
              'm.confidence',
              'm.rationale',
              'm.evidence_ids',
              'm.status',
              'm.created_at',
            ])
            .where('m.tenant_id', '=', ctx.tenantId)
            .where('m.company_id', '=', request.params.id)
            .orderBy('m.created_at', 'desc')
            .execute();
          const titles = await trx
            .selectFrom('employment_roles')
            .select(['person_id', 'title'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', request.params.id)
            .execute();
          const titleByPerson = new Map(titles.map((t) => [t.person_id, t.title]));
          const coverage = await loadCoverage(trx, ctx.tenantId, request.params.id);
          return {
            note: 'Stakeholder classifications only. Reporting lines come from sourced relationships, never invented here.',
            coverage,
            data: rows.map((r) => ({
              id: r.id,
              company_id: r.company_id,
              person_id: r.person_id,
              person_name: r.canonical_name,
              person_title: titleByPerson.get(r.person_id) ?? null,
              committee_role: r.committee_role as z.infer<typeof CommitteeRoleEnum>,
              claim_type: r.claim_type as z.infer<typeof ClaimType>,
              confidence: Number(r.confidence),
              rationale: r.rationale,
              evidence_ids: parseEvidenceIds(r.evidence_ids),
              status: r.status as 'active' | 'dismissed',
              created_at: r.created_at.toISOString(),
            })),
          };
        });
      },
    );

    app.post(
      '/companies/:id/buying-committee',
      {
        schema: {
          tags: ['committee'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            person_id: z.uuid(),
            committee_role: CommitteeRoleEnum,
            claim_type: ClaimType.default('user_assertion'),
            confidence: z.number().min(0).max(1).default(0.5),
            rationale: z.string().min(1).max(2000),
            evidence_ids: z.array(z.uuid()).max(20).default([]),
          }),
          response: { 201: z.object({ member: Member, coverage: Coverage }) },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'committee.write');
        const result = await withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'buying_committee');
          const company = await loadCompany(trx, ctx.tenantId, request.params.id);
          const person = await trx
            .selectFrom('people')
            .select(['id', 'canonical_name'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.body.person_id)
            .where('merged_into_id', 'is', null)
            .executeTakeFirst();
          if (!person) throw notFound('Person');
          const link = await trx
            .selectFrom('person_company_links')
            .select('person_id')
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', company.id)
            .where('person_id', '=', person.id)
            .executeTakeFirst();
          if (!link) {
            throw new AppError(
              'VALIDATION_ERROR',
              'Person must be linked to this company before committee classification.',
            );
          }
          assertGrounding(
            request.body.committee_role,
            request.body.claim_type,
            request.body.evidence_ids,
          );
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
          const row = await trx
            .insertInto('buying_committee_members')
            .values({
              tenant_id: ctx.tenantId,
              company_id: company.id,
              person_id: person.id,
              committee_role: request.body.committee_role,
              claim_type: request.body.claim_type,
              confidence: String(request.body.confidence),
              rationale: request.body.rationale,
              evidence_ids: JSON.stringify(request.body.evidence_ids),
              status: 'active',
              created_by: ctx.userId,
            })
            .onConflict((oc) =>
              oc.columns(['tenant_id', 'company_id', 'person_id', 'committee_role']).doUpdateSet({
                claim_type: request.body.claim_type,
                confidence: String(request.body.confidence),
                rationale: request.body.rationale,
                evidence_ids: JSON.stringify(request.body.evidence_ids),
                status: 'active',
                updated_by: ctx.userId,
              }),
            )
            .returningAll()
            .executeTakeFirstOrThrow();
          const role = await trx
            .selectFrom('employment_roles')
            .select('title')
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', company.id)
            .where('person_id', '=', person.id)
            .executeTakeFirst();
          const coverage = await loadCoverage(trx, ctx.tenantId, company.id);
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'committee.member_upserted',
            entityType: 'company',
            entityId: company.id,
            correlationId: ctx.correlationId,
            metadata: {
              person_id: person.id,
              committee_role: request.body.committee_role,
              coverage_score: coverage.coverage_score,
            },
          });
          return {
            coverage,
            member: {
              id: row.id,
              company_id: row.company_id,
              person_id: row.person_id,
              person_name: person.canonical_name,
              person_title: role?.title ?? null,
              committee_role: row.committee_role as z.infer<typeof CommitteeRoleEnum>,
              claim_type: row.claim_type as z.infer<typeof ClaimType>,
              confidence: Number(row.confidence),
              rationale: row.rationale,
              evidence_ids: parseEvidenceIds(row.evidence_ids),
              status: row.status as 'active' | 'dismissed',
              created_at: row.created_at.toISOString(),
            },
          };
        });
        return reply.status(201).send(result);
      },
    );

    app.patch(
      '/buying-committee/:id',
      {
        schema: {
          tags: ['committee'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            status: z.enum(['active', 'dismissed']).optional(),
            rationale: z.string().min(1).max(2000).optional(),
          }),
          response: { 200: Member },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'committee.write');
        return withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'buying_committee');
          const existing = await trx
            .selectFrom('buying_committee_members')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!existing) throw notFound('Committee member');
          const row = await trx
            .updateTable('buying_committee_members')
            .set({
              status: request.body.status ?? existing.status,
              rationale: request.body.rationale ?? existing.rationale,
              updated_by: ctx.userId,
            })
            .where('id', '=', existing.id)
            .where('tenant_id', '=', ctx.tenantId)
            .returningAll()
            .executeTakeFirstOrThrow();
          const person = await trx
            .selectFrom('people')
            .select('canonical_name')
            .where('id', '=', row.person_id)
            .executeTakeFirst();
          return {
            id: row.id,
            company_id: row.company_id,
            person_id: row.person_id,
            person_name: person?.canonical_name ?? null,
            person_title: null,
            committee_role: row.committee_role as z.infer<typeof CommitteeRoleEnum>,
            claim_type: row.claim_type as z.infer<typeof ClaimType>,
            confidence: Number(row.confidence),
            rationale: row.rationale,
            evidence_ids: parseEvidenceIds(row.evidence_ids),
            status: row.status as 'active' | 'dismissed',
            created_at: row.created_at.toISOString(),
          };
        });
      },
    );

    app.get(
      '/companies/:id/account-plans',
      {
        schema: {
          tags: ['committee'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ data: z.array(Plan), note: z.string() }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'plan.read');
        return withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'account_plans');
          await loadCompany(trx, ctx.tenantId, request.params.id);
          const rows = await trx
            .selectFrom('account_plans')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', request.params.id)
            .orderBy('version', 'desc')
            .limit(50)
            .execute();
          return {
            note: 'Versioned account plans. Reporting lines are never invented.',
            data: rows.map(toPlan),
          };
        });
      },
    );

    app.post(
      '/companies/:id/account-plans',
      {
        schema: {
          tags: ['committee'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            title: z.string().min(1).max(200),
            situation: z.string().min(1).max(4000),
            objective: z.string().min(1).max(2000),
            strategy: z.string().min(1).max(4000),
            risks: z.string().max(4000).optional().default(''),
            next_steps: z.string().min(1).max(4000),
            assigned_manager_user_id: z.uuid().nullable().optional(),
            activate: z.boolean().optional().default(false),
          }),
          response: { 201: Plan },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'plan.write');
        const plan = await withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'account_plans');
          const company = await loadCompany(trx, ctx.tenantId, request.params.id);
          if (request.body.assigned_manager_user_id) {
            const member = await trx
              .selectFrom('memberships')
              .select('user_id')
              .where('tenant_id', '=', ctx.tenantId)
              .where('user_id', '=', request.body.assigned_manager_user_id)
              .executeTakeFirst();
            if (!member) {
              throw new AppError('VALIDATION_ERROR', 'Manager must be a workspace member.');
            }
          }
          const coverage = await loadCoverage(trx, ctx.tenantId, company.id);
          const latest = await trx
            .selectFrom('account_plans')
            .select('version')
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', company.id)
            .orderBy('version', 'desc')
            .limit(1)
            .executeTakeFirst();
          const version = (latest?.version ?? 0) + 1;
          if (request.body.activate) {
            await trx
              .updateTable('account_plans')
              .set({ status: 'archived', updated_by: ctx.userId })
              .where('tenant_id', '=', ctx.tenantId)
              .where('company_id', '=', company.id)
              .where('status', '=', 'active')
              .execute();
          }
          const row = await trx
            .insertInto('account_plans')
            .values({
              tenant_id: ctx.tenantId,
              company_id: company.id,
              version,
              status: request.body.activate ? 'active' : 'draft',
              title: request.body.title,
              situation: request.body.situation,
              objective: request.body.objective,
              strategy: request.body.strategy,
              risks: request.body.risks,
              next_steps: request.body.next_steps,
              coverage_score: coverage.coverage_score,
              coverage_note: coverage.note,
              assigned_manager_user_id: request.body.assigned_manager_user_id ?? null,
              created_by: ctx.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          if (request.body.assigned_manager_user_id) {
            await trx
              .insertInto('account_assignments')
              .values({
                tenant_id: ctx.tenantId,
                company_id: company.id,
                manager_user_id: request.body.assigned_manager_user_id,
              })
              .onConflict((oc) =>
                oc.columns(['tenant_id', 'company_id']).doUpdateSet({
                  manager_user_id: request.body.assigned_manager_user_id!,
                }),
              )
              .execute();
          }

          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'plan.created',
            entityType: 'account_plan',
            entityId: row.id,
            correlationId: ctx.correlationId,
            metadata: { version, coverage_score: coverage.coverage_score },
          });
          return toPlan(row);
        });
        return reply.status(201).send(plan);
      },
    );

    app.patch(
      '/account-plans/:id',
      {
        schema: {
          tags: ['committee'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            status: z.enum(['draft', 'active', 'archived']).optional(),
            assigned_manager_user_id: z.uuid().nullable().optional(),
            next_steps: z.string().min(1).max(4000).optional(),
            risks: z.string().max(4000).optional(),
          }),
          response: { 200: Plan },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'plan.write');
        return withContext(db, ctx, async (trx) => {
          await requireFlag(trx, ctx.tenantId, 'account_plans');
          const existing = await trx
            .selectFrom('account_plans')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!existing) throw notFound('Account plan');

          if (request.body.status === 'active') {
            await trx
              .updateTable('account_plans')
              .set({ status: 'archived', updated_by: ctx.userId })
              .where('tenant_id', '=', ctx.tenantId)
              .where('company_id', '=', existing.company_id)
              .where('status', '=', 'active')
              .where('id', '!=', existing.id)
              .execute();
          }

          if (request.body.assigned_manager_user_id) {
            const member = await trx
              .selectFrom('memberships')
              .select('user_id')
              .where('tenant_id', '=', ctx.tenantId)
              .where('user_id', '=', request.body.assigned_manager_user_id)
              .executeTakeFirst();
            if (!member) {
              throw new AppError('VALIDATION_ERROR', 'Manager must be a workspace member.');
            }
            await trx
              .insertInto('account_assignments')
              .values({
                tenant_id: ctx.tenantId,
                company_id: existing.company_id,
                manager_user_id: request.body.assigned_manager_user_id,
              })
              .onConflict((oc) =>
                oc.columns(['tenant_id', 'company_id']).doUpdateSet({
                  manager_user_id: request.body.assigned_manager_user_id!,
                }),
              )
              .execute();
          }

          const coverage = await loadCoverage(trx, ctx.tenantId, existing.company_id);
          const row = await trx
            .updateTable('account_plans')
            .set({
              status: request.body.status ?? existing.status,
              assigned_manager_user_id:
                request.body.assigned_manager_user_id === undefined
                  ? existing.assigned_manager_user_id
                  : request.body.assigned_manager_user_id,
              next_steps: request.body.next_steps ?? existing.next_steps,
              risks: request.body.risks ?? existing.risks,
              coverage_score: coverage.coverage_score,
              coverage_note: coverage.note,
              updated_by: ctx.userId,
            })
            .where('id', '=', existing.id)
            .where('tenant_id', '=', ctx.tenantId)
            .returningAll()
            .executeTakeFirstOrThrow();

          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'plan.updated',
            entityType: 'account_plan',
            entityId: row.id,
            correlationId: ctx.correlationId,
            metadata: request.body,
          });
          return toPlan(row);
        });
      },
    );
  };
