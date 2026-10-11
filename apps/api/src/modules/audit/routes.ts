import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { requireTenant } from '../../http/context.ts';
import { decodeCursor, PageMeta, PageQuery, paginate } from '../../http/pagination.ts';

const AuditEvent = z.object({
  id: z.string(),
  actor_user_id: z.string().nullable(),
  actor_type: z.string(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string().nullable(),
  outcome: z.string(),
  correlation_id: z.string(),
  metadata: z.unknown(),
  created_at: z.string(),
});

export const auditRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/audit-events',
      {
        schema: {
          tags: ['audit'],
          querystring: PageQuery.extend({
            entity_type: z.string().max(50).optional(),
            entity_id: z.string().max(100).optional(),
          }),
          response: { 200: z.object({ data: z.array(AuditEvent), ...PageMeta }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'audit.read');
        const { limit, entity_type, entity_id } = request.query;
        const cursor = decodeCursor(request.query.cursor);
        const rows = await withContext(db, ctx, (trx) => {
          let q = trx
            .selectFrom('audit_events')
            .select([
              'id',
              'actor_user_id',
              'actor_type',
              'action',
              'entity_type',
              'entity_id',
              'outcome',
              'correlation_id',
              'metadata',
              'created_at',
            ])
            .where('tenant_id', '=', ctx.tenantId);
          if (entity_type) q = q.where('entity_type', '=', entity_type);
          if (entity_id) q = q.where('entity_id', '=', entity_id);
          if (cursor) {
            q = q.where((eb) =>
              eb.or([
                eb('created_at', '<', new Date(cursor.t)),
                eb.and([eb('created_at', '=', new Date(cursor.t)), eb('id', '<', cursor.id)]),
              ]),
            );
          }
          return q
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .limit(limit + 1)
            .execute();
        });
        const { page, ...meta } = paginate(rows, limit);
        return {
          data: page.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
          ...meta,
        };
      },
    );
  };
