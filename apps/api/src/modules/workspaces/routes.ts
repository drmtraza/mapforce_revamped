import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql, withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant, requireUser } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';

const MAX_OWNED_WORKSPACES = 20;

const Role = z.enum(['owner', 'admin', 'manager', 'researcher', 'representative', 'auditor']);
const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  role: Role,
  created_at: z.string(),
});

export const workspaceRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, config } = deps;

    app.get(
      '/workspaces',
      {
        schema: {
          tags: ['workspaces'],
          response: { 200: z.object({ data: z.array(Workspace) }) },
        },
      },
      async (request) => {
        const user = requireUser(request);
        const rows = await withContext(db, { tenantId: null, userId: user.userId }, (trx) =>
          trx
            .selectFrom('memberships as m')
            .innerJoin('tenants as t', 't.id', 'm.tenant_id')
            .select(['t.id', 't.name', 'm.role', 't.created_at'])
            .where('m.user_id', '=', user.userId)
            .where('m.status', '=', 'active')
            .orderBy('t.created_at', 'asc')
            .limit(100)
            .execute(),
        );
        return {
          data: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
        };
      },
    );

    app.post(
      '/workspaces',
      {
        schema: {
          tags: ['workspaces'],
          body: z.object({ name: z.string().trim().min(1).max(120) }),
          response: { 201: Workspace },
        },
      },
      async (request, reply) => {
        const user = requireUser(request);
        const tenantId = randomUUID();
        const created = await withContext(db, { tenantId, userId: user.userId }, async (trx) => {
          const owned = await trx
            .selectFrom('memberships')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('user_id', '=', user.userId)
            .where('role', '=', 'owner')
            .executeTakeFirstOrThrow();
          if (Number(owned.n) >= MAX_OWNED_WORKSPACES) {
            throw new AppError('QUOTA_EXCEEDED', 'Workspace limit reached for this user.');
          }
          const planId = config.DEFAULT_TENANT_PLAN;
          if (planId === 'beta') {
            const seats = await sql<{
              n: number;
            }>`SELECT count_tenants_on_plan('beta') AS n`.execute(trx);
            if (Number(seats.rows[0]?.n ?? 0) >= config.MAX_BETA_TENANTS) {
              throw new AppError(
                'QUOTA_EXCEEDED',
                `At most ${config.MAX_BETA_TENANTS} beta workspaces are allowed.`,
              );
            }
          }
          const tenant = await trx
            .insertInto('tenants')
            .values({ id: tenantId, name: request.body.name, plan_id: planId })
            .returning(['id', 'name', 'created_at'])
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('memberships')
            .values({ tenant_id: tenantId, user_id: user.userId, role: 'owner' })
            .execute();
          await recordAudit(trx, {
            tenantId,
            actorUserId: user.userId,
            action: 'workspace.created',
            entityType: 'workspace',
            entityId: tenantId,
            correlationId: user.correlationId,
          });
          return tenant;
        });
        return reply.status(201).send({
          id: created.id,
          name: created.name,
          role: 'owner' as const,
          created_at: created.created_at.toISOString(),
        });
      },
    );

    app.get(
      '/workspaces/:workspaceId/members',
      {
        schema: {
          tags: ['workspaces'],
          params: z.object({ workspaceId: z.uuid() }),
          response: {
            200: z.object({
              data: z.array(
                z.object({
                  user_id: z.string(),
                  email: z.string(),
                  display_name: z.string().nullable(),
                  role: Role,
                  status: z.string(),
                }),
              ),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'members.read');
        if (request.params.workspaceId.toLowerCase() !== ctx.tenantId) throw notFound('Workspace');
        const rows = await withContext(db, ctx, (trx) =>
          trx
            .selectFrom('memberships as m')
            .innerJoin('users as u', 'u.id', 'm.user_id')
            .select(['m.user_id', 'u.email', 'u.display_name', 'm.role', 'm.status'])
            .where('m.tenant_id', '=', ctx.tenantId)
            .orderBy('m.created_at', 'asc')
            .limit(500)
            .execute(),
        );
        return { data: rows };
      },
    );
  };
