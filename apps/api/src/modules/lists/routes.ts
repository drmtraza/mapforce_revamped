import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { loadCompany } from '../companies/routes.ts';
import { isDomainSuppressed, isPersonSuppressed } from '../suppressions/check.ts';

const List = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['companies', 'people']),
  item_count: z.number(),
  created_at: z.string(),
});

const Item = z.object({
  id: z.string(),
  entity_type: z.enum(['company', 'person']),
  entity_id: z.string(),
  display_name: z.string(),
  created_at: z.string(),
});

export const listRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/lists',
      {
        schema: { tags: ['lists'], response: { 200: z.object({ data: z.array(List) }) } },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'list.read');
        const rows = await withContext(db, ctx, async (trx) => {
          const lists = await trx
            .selectFrom('workspace_lists')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .orderBy('created_at', 'desc')
            .limit(100)
            .execute();
          const counts = await trx
            .selectFrom('list_items')
            .select(['list_id', (eb) => eb.fn.countAll<string>().as('n')])
            .where('tenant_id', '=', ctx.tenantId)
            .groupBy('list_id')
            .execute();
          const byList = new Map(counts.map((r) => [r.list_id, Number(r.n)]));
          return lists.map((l) => ({
            id: l.id,
            name: l.name,
            kind: l.kind,
            item_count: byList.get(l.id) ?? 0,
            created_at: l.created_at.toISOString(),
          }));
        });
        return { data: rows };
      },
    );

    app.post(
      '/lists',
      {
        schema: {
          tags: ['lists'],
          body: z.object({
            name: z.string().trim().min(1).max(120),
            kind: z.enum(['companies', 'people']),
          }),
          response: { 201: List },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'list.write');
        const row = await withContext(db, ctx, async (trx) => {
          const created = await trx
            .insertInto('workspace_lists')
            .values({
              tenant_id: ctx.tenantId,
              name: request.body.name,
              kind: request.body.kind,
              created_by: ctx.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'list.created',
            entityType: 'list',
            entityId: created.id,
            correlationId: ctx.correlationId,
          });
          return created;
        });
        return reply.status(201).send({
          id: row.id,
          name: row.name,
          kind: row.kind,
          item_count: 0,
          created_at: row.created_at.toISOString(),
        });
      },
    );

    app.get(
      '/lists/:id',
      {
        schema: {
          tags: ['lists'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ list: List, items: z.array(Item) }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'list.read');
        return withContext(db, ctx, async (trx) => {
          const list = await trx
            .selectFrom('workspace_lists')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!list) throw notFound('List');
          const items = await trx
            .selectFrom('list_items')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('list_id', '=', list.id)
            .orderBy('created_at', 'desc')
            .limit(500)
            .execute();
          const named = [];
          for (const item of items) {
            let display = item.entity_id;
            if (item.entity_type === 'company') {
              const c = await trx
                .selectFrom('companies')
                .select('canonical_name')
                .where('tenant_id', '=', ctx.tenantId)
                .where('id', '=', item.entity_id)
                .executeTakeFirst();
              display = c?.canonical_name ?? display;
            } else {
              const p = await trx
                .selectFrom('people')
                .select('canonical_name')
                .where('tenant_id', '=', ctx.tenantId)
                .where('id', '=', item.entity_id)
                .executeTakeFirst();
              display = p?.canonical_name ?? display;
            }
            named.push({
              id: item.id,
              entity_type: item.entity_type,
              entity_id: item.entity_id,
              display_name: display,
              created_at: item.created_at.toISOString(),
            });
          }
          return {
            list: {
              id: list.id,
              name: list.name,
              kind: list.kind,
              item_count: named.length,
              created_at: list.created_at.toISOString(),
            },
            items: named,
          };
        });
      },
    );

    app.post(
      '/lists/:id/items',
      {
        schema: {
          tags: ['lists'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            entity_type: z.enum(['company', 'person']),
            entity_id: z.uuid(),
          }),
          response: { 201: Item },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'list.write');
        const item = await withContext(db, ctx, async (trx) => {
          const list = await trx
            .selectFrom('workspace_lists')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!list) throw notFound('List');
          const expected = list.kind === 'companies' ? 'company' : 'person';
          if (request.body.entity_type !== expected) {
            throw new AppError('VALIDATION_ERROR', `This list only accepts ${list.kind}.`);
          }
          let display: string;
          if (request.body.entity_type === 'company') {
            const company = await loadCompany(trx, ctx.tenantId, request.body.entity_id);
            if (await isDomainSuppressed(trx, ctx.tenantId, company.primary_domain)) {
              throw new AppError('SUPPRESSED', 'Suppressed companies cannot be added to lists.');
            }
            display = company.canonical_name;
          } else {
            const person = await trx
              .selectFrom('people')
              .select(['id', 'canonical_name'])
              .where('tenant_id', '=', ctx.tenantId)
              .where('id', '=', request.body.entity_id)
              .executeTakeFirst();
            if (!person) throw notFound('Person');
            if (await isPersonSuppressed(trx, ctx.tenantId, person.id)) {
              throw new AppError('SUPPRESSED', 'Suppressed people cannot be added to lists.');
            }
            display = person.canonical_name;
          }
          const inserted = await trx
            .insertInto('list_items')
            .values({
              tenant_id: ctx.tenantId,
              list_id: list.id,
              entity_type: request.body.entity_type,
              entity_id: request.body.entity_id,
            })
            .onConflict((oc) => oc.columns(['list_id', 'entity_type', 'entity_id']).doNothing())
            .returningAll()
            .executeTakeFirst();
          const row =
            inserted ??
            (await trx
              .selectFrom('list_items')
              .selectAll()
              .where('list_id', '=', list.id)
              .where('entity_type', '=', request.body.entity_type)
              .where('entity_id', '=', request.body.entity_id)
              .executeTakeFirstOrThrow());
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'list.item.added',
            entityType: 'list',
            entityId: list.id,
            correlationId: ctx.correlationId,
            metadata: { entity_type: request.body.entity_type },
          });
          return {
            id: row.id,
            entity_type: row.entity_type,
            entity_id: row.entity_id,
            display_name: display,
            created_at: row.created_at.toISOString(),
          };
        });
        return reply.status(201).send(item);
      },
    );

    app.delete(
      '/lists/:id/items/:itemId',
      {
        schema: {
          tags: ['lists'],
          params: z.object({ id: z.uuid(), itemId: z.uuid() }),
          response: { 204: z.undefined() },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'list.write');
        await withContext(db, ctx, async (trx) => {
          const deleted = await trx
            .deleteFrom('list_items')
            .where('tenant_id', '=', ctx.tenantId)
            .where('list_id', '=', request.params.id)
            .where('id', '=', request.params.itemId)
            .executeTakeFirst();
          if (!deleted.numDeletedRows) throw notFound('List item');
        });
        return reply.status(204).send();
      },
    );
  };
