import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';

const DeadLetter = z.object({
  id: z.string(),
  event_type: z.string(),
  attempts: z.number(),
  last_error: z.string().nullable(),
  occurred_at: z.string(),
  dead_lettered_at: z.string(),
  correlation_id: z.string(),
});

/** Payloads are not exposed: they may carry workflow inputs that are not meant for display. */
export const deadLetterRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/dead-letters',
      {
        schema: {
          tags: ['operations'],
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
          response: { 200: z.object({ data: z.array(DeadLetter) }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'outbox.manage');
        const rows = await withContext(db, ctx, (trx) =>
          trx
            .selectFrom('outbox_events')
            .select([
              'id',
              'event_type',
              'attempts',
              'last_error',
              'occurred_at',
              'dead_lettered_at',
              'correlation_id',
            ])
            .where('tenant_id', '=', ctx.tenantId)
            .where('dead_lettered_at', 'is not', null)
            .where('published_at', 'is', null)
            .orderBy('dead_lettered_at', 'desc')
            .limit(request.query.limit)
            .execute(),
        );
        return {
          data: rows.map((r) => ({
            ...r,
            occurred_at: r.occurred_at.toISOString(),
            dead_lettered_at: (r.dead_lettered_at as Date).toISOString(),
          })),
        };
      },
    );

    app.post(
      '/dead-letters/:id/replay',
      {
        schema: {
          tags: ['operations'],
          params: z.object({ id: z.uuid() }),
          response: { 202: z.object({ id: z.string(), status: z.literal('requeued') }) },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'outbox.manage');
        await withContext(db, ctx, async (trx) => {
          const event = await trx
            .selectFrom('outbox_events')
            .select(['id', 'event_type', 'dead_lettered_at', 'published_at', 'attempts'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!event) throw notFound('Event');
          if (!event.dead_lettered_at || event.published_at) {
            throw new AppError(
              'INVALID_STATE',
              'Only undelivered dead-lettered events can be replayed.',
            );
          }
          await trx
            .updateTable('outbox_events')
            .set({
              dead_lettered_at: null,
              attempts: 0,
              next_attempt_at: new Date(),
              last_error: null,
            })
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', event.id)
            .execute();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'outbox.replayed',
            entityType: 'outbox_event',
            entityId: event.id,
            correlationId: ctx.correlationId,
            metadata: { event_type: event.event_type, previous_attempts: event.attempts },
          });
        });
        return reply.status(202).send({ id: request.params.id, status: 'requeued' as const });
      },
    );
  };
