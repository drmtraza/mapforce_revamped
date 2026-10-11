import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { loadCompany } from '../companies/routes.ts';

const Task = z.object({
  id: z.string(),
  company_id: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(['open', 'done', 'cancelled']),
  due_at: z.string().nullable(),
  owner_user_id: z.string().nullable(),
  created_at: z.string(),
});

const Note = z.object({
  id: z.string(),
  company_id: z.string().nullable(),
  author_user_id: z.string(),
  body: z.string(),
  created_at: z.string(),
});

export const crmRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/companies/:id/tasks',
      {
        schema: {
          tags: ['crm'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ data: z.array(Task) }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        const rows = await withContext(db, ctx, async (trx) => {
          await loadCompany(trx, ctx.tenantId, request.params.id);
          return trx
            .selectFrom('tasks')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', request.params.id)
            .orderBy('created_at', 'desc')
            .limit(100)
            .execute();
        });
        return {
          data: rows.map((r) => ({
            id: r.id,
            company_id: r.company_id,
            title: r.title,
            description: r.description,
            status: r.status,
            due_at: r.due_at?.toISOString() ?? null,
            owner_user_id: r.owner_user_id,
            created_at: r.created_at.toISOString(),
          })),
        };
      },
    );

    app.post(
      '/tasks',
      {
        schema: {
          tags: ['crm'],
          body: z.object({
            company_id: z.uuid(),
            title: z.string().trim().min(1).max(200),
            description: z.string().trim().max(4000).optional(),
            due_at: z.string().optional(),
          }),
          response: { 201: Task },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'task.write');
        const row = await withContext(db, ctx, async (trx) => {
          await loadCompany(trx, ctx.tenantId, request.body.company_id);
          const created = await trx
            .insertInto('tasks')
            .values({
              tenant_id: ctx.tenantId,
              company_id: request.body.company_id,
              title: request.body.title,
              description: request.body.description ?? null,
              due_at: request.body.due_at ? new Date(request.body.due_at) : null,
              owner_user_id: ctx.userId,
              created_by: ctx.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'task.created',
            entityType: 'task',
            entityId: created.id,
            correlationId: ctx.correlationId,
          });
          return created;
        });
        return reply.status(201).send({
          id: row.id,
          company_id: row.company_id,
          title: row.title,
          description: row.description,
          status: row.status,
          due_at: row.due_at?.toISOString() ?? null,
          owner_user_id: row.owner_user_id,
          created_at: row.created_at.toISOString(),
        });
      },
    );

    app.patch(
      '/tasks/:id',
      {
        schema: {
          tags: ['crm'],
          params: z.object({ id: z.uuid() }),
          body: z.object({ status: z.enum(['open', 'done', 'cancelled']) }),
          response: { 200: Task },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'task.write');
        const row = await withContext(db, ctx, async (trx) => {
          const updated = await trx
            .updateTable('tasks')
            .set({ status: request.body.status })
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .returningAll()
            .executeTakeFirst();
          if (!updated) throw notFound('Task');
          return updated;
        });
        return {
          id: row.id,
          company_id: row.company_id,
          title: row.title,
          description: row.description,
          status: row.status,
          due_at: row.due_at?.toISOString() ?? null,
          owner_user_id: row.owner_user_id,
          created_at: row.created_at.toISOString(),
        };
      },
    );

    app.get(
      '/companies/:id/notes',
      {
        schema: {
          tags: ['crm'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ data: z.array(Note) }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        const rows = await withContext(db, ctx, async (trx) => {
          await loadCompany(trx, ctx.tenantId, request.params.id);
          return trx
            .selectFrom('notes')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', request.params.id)
            .orderBy('created_at', 'desc')
            .limit(100)
            .execute();
        });
        return {
          data: rows.map((r) => ({
            id: r.id,
            company_id: r.company_id,
            author_user_id: r.author_user_id,
            body: r.body,
            created_at: r.created_at.toISOString(),
          })),
        };
      },
    );

    app.post(
      '/notes',
      {
        schema: {
          tags: ['crm'],
          body: z.object({
            company_id: z.uuid(),
            body: z.string().trim().min(1).max(4000),
          }),
          response: { 201: Note },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'note.write');
        const row = await withContext(db, ctx, async (trx) => {
          await loadCompany(trx, ctx.tenantId, request.body.company_id);
          const created = await trx
            .insertInto('notes')
            .values({
              tenant_id: ctx.tenantId,
              company_id: request.body.company_id,
              author_user_id: ctx.userId,
              body: request.body.body,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'note.created',
            entityType: 'note',
            entityId: created.id,
            correlationId: ctx.correlationId,
          });
          return created;
        });
        return reply.status(201).send({
          id: row.id,
          company_id: row.company_id,
          author_user_id: row.author_user_id,
          body: row.body,
          created_at: row.created_at.toISOString(),
        });
      },
    );
  };
