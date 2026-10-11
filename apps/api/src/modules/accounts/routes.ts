import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { loadCompany } from '../companies/routes.ts';

export const STAGES = [
  'identified',
  'researching',
  'qualified',
  'outreach',
  'meeting',
  'closed_won',
  'closed_lost',
  'on_hold',
] as const;

const Account = z.object({
  company_id: z.string(),
  canonical_name: z.string(),
  primary_domain: z.string(),
  owner_user_id: z.string().nullable(),
  stage: z.enum(STAGES),
  priority: z.enum(['low', 'normal', 'high']),
  next_action_at: z.string().nullable(),
  total_score: z.number().nullable(),
  eligible: z.boolean().nullable(),
  updated_at: z.string(),
});

export const accountRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/accounts',
      {
        schema: {
          tags: ['accounts'],
          querystring: z.object({
            stage: z.enum(STAGES).optional(),
            owner_user_id: z.uuid().optional(),
          }),
          response: { 200: z.object({ data: z.array(Account) }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        const rows = await withContext(db, ctx, async (trx) => {
          let q = trx
            .selectFrom('companies as c')
            .leftJoin('account_assignments as a', (j) =>
              j.onRef('a.company_id', '=', 'c.id').onRef('a.tenant_id', '=', 'c.tenant_id'),
            )
            .select([
              'c.id as company_id',
              'c.canonical_name',
              'c.primary_domain',
              'a.owner_user_id',
              'a.stage',
              'a.priority',
              'a.next_action_at',
              'a.updated_at',
              'c.updated_at as company_updated_at',
            ])
            .where('c.tenant_id', '=', ctx.tenantId)
            .orderBy('c.canonical_name')
            .limit(500);
          if (request.query.stage) q = q.where('a.stage', '=', request.query.stage);
          if (request.query.owner_user_id) {
            q = q.where('a.owner_user_id', '=', request.query.owner_user_id);
          }
          const accounts = await q.execute();
          const scores = await trx
            .selectFrom('score_runs')
            .select(['company_id', 'total_score', 'eligible', 'created_at'])
            .where('tenant_id', '=', ctx.tenantId)
            .orderBy('created_at', 'desc')
            .limit(2000)
            .execute();
          const latest = new Map<string, { total_score: number; eligible: boolean }>();
          for (const s of scores) {
            if (!latest.has(s.company_id)) {
              latest.set(s.company_id, { total_score: s.total_score, eligible: s.eligible });
            }
          }
          return accounts.map((r) => ({
            company_id: r.company_id,
            canonical_name: r.canonical_name,
            primary_domain: r.primary_domain,
            owner_user_id: r.owner_user_id,
            stage: (r.stage ?? 'identified') as (typeof STAGES)[number],
            priority: (r.priority ?? 'normal') as 'low' | 'normal' | 'high',
            next_action_at: r.next_action_at?.toISOString() ?? null,
            total_score: latest.get(r.company_id)?.total_score ?? null,
            eligible: latest.get(r.company_id)?.eligible ?? null,
            updated_at: (r.updated_at ?? r.company_updated_at).toISOString(),
          }));
        });
        return { data: rows };
      },
    );

    app.patch(
      '/accounts/:companyId',
      {
        schema: {
          tags: ['accounts'],
          params: z.object({ companyId: z.uuid() }),
          body: z.object({
            owner_user_id: z.uuid().nullable().optional(),
            stage: z.enum(STAGES).optional(),
            priority: z.enum(['low', 'normal', 'high']).optional(),
            next_action_at: z.string().nullable().optional(),
          }),
          response: { 200: Account },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'account.assign');
        return withContext(db, ctx, async (trx) => {
          const company = await loadCompany(trx, ctx.tenantId, request.params.companyId);
          if (request.body.owner_user_id) {
            const member = await trx
              .selectFrom('memberships')
              .select('user_id')
              .where('tenant_id', '=', ctx.tenantId)
              .where('user_id', '=', request.body.owner_user_id)
              .where('status', '=', 'active')
              .executeTakeFirst();
            if (!member) throw notFound('Member');
          }
          const existing = await trx
            .selectFrom('account_assignments')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', company.id)
            .executeTakeFirst();
          const next = {
            owner_user_id:
              request.body.owner_user_id === undefined
                ? (existing?.owner_user_id ?? null)
                : request.body.owner_user_id,
            stage: request.body.stage ?? existing?.stage ?? 'identified',
            priority: request.body.priority ?? existing?.priority ?? 'normal',
            next_action_at:
              request.body.next_action_at === undefined
                ? (existing?.next_action_at ?? null)
                : request.body.next_action_at
                  ? new Date(request.body.next_action_at)
                  : null,
          };
          await trx
            .insertInto('account_assignments')
            .values({
              tenant_id: ctx.tenantId,
              company_id: company.id,
              ...next,
            })
            .onConflict((oc) =>
              oc.columns(['tenant_id', 'company_id']).doUpdateSet({
                owner_user_id: next.owner_user_id,
                stage: next.stage,
                priority: next.priority,
                next_action_at: next.next_action_at,
              }),
            )
            .execute();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'account.assigned',
            entityType: 'company',
            entityId: company.id,
            correlationId: ctx.correlationId,
            metadata: { stage: next.stage },
          });
          return {
            company_id: company.id,
            canonical_name: company.canonical_name,
            primary_domain: company.primary_domain,
            owner_user_id: next.owner_user_id,
            stage: next.stage,
            priority: next.priority,
            next_action_at: next.next_action_at?.toISOString() ?? null,
            total_score: null,
            eligible: null,
            updated_at: new Date().toISOString(),
          };
        });
      },
    );
  };
