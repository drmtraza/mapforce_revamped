import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { displayHint, hashContactValue } from '../contacts/crypto.ts';

const Suppression = z.object({
  id: z.string(),
  subject_type: z.enum(['email', 'phone', 'domain', 'person']),
  display_hint: z.string(),
  reason: z.string().nullable(),
  created_at: z.string(),
});

export const suppressionRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/suppressions',
      {
        schema: {
          tags: ['suppressions'],
          response: { 200: z.object({ data: z.array(Suppression) }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'suppression.read');
        const rows = await withContext(db, ctx, async (trx) =>
          trx
            .selectFrom('consent_suppressions')
            .select(['id', 'subject_type', 'display_hint', 'reason', 'created_at'])
            .where('tenant_id', '=', ctx.tenantId)
            .orderBy('created_at', 'desc')
            .limit(200)
            .execute(),
        );
        return {
          data: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
        };
      },
    );

    app.post(
      '/suppressions',
      {
        schema: {
          tags: ['suppressions'],
          body: z.object({
            subject_type: z.enum(['email', 'phone', 'domain', 'person']),
            value: z.string().trim().min(1).max(320),
            reason: z.string().trim().max(2000).optional(),
          }),
          response: { 201: Suppression },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'suppression.write');
        const { subject_type, value, reason } = request.body;
        const row = await withContext(db, ctx, async (trx) => {
          const inserted = await trx
            .insertInto('consent_suppressions')
            .values({
              tenant_id: ctx.tenantId,
              subject_type,
              value_hash: hashContactValue(subject_type, value),
              display_hint: displayHint(subject_type, value),
              reason: reason ?? null,
              created_by: ctx.userId,
            })
            .onConflict((oc) => oc.columns(['tenant_id', 'subject_type', 'value_hash']).doNothing())
            .returning(['id', 'subject_type', 'display_hint', 'reason', 'created_at'])
            .executeTakeFirst();
          const existing =
            inserted ??
            (await trx
              .selectFrom('consent_suppressions')
              .select(['id', 'subject_type', 'display_hint', 'reason', 'created_at'])
              .where('tenant_id', '=', ctx.tenantId)
              .where('subject_type', '=', subject_type)
              .where('value_hash', '=', hashContactValue(subject_type, value))
              .executeTakeFirstOrThrow());
          if (subject_type === 'email' || subject_type === 'phone') {
            await trx
              .updateTable('contact_points')
              .set({ status: 'suppressed' })
              .where('tenant_id', '=', ctx.tenantId)
              .where('normalized_value_hash', '=', hashContactValue(subject_type, value))
              .execute();
          }
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'suppression.created',
            entityType: 'suppression',
            entityId: existing.id,
            correlationId: ctx.correlationId,
            metadata: { subject_type },
          });
          return existing;
        });
        return reply.status(insertedStatus(row)).send({
          ...row,
          created_at: row.created_at.toISOString(),
        });
      },
    );
  };

function insertedStatus(row: { created_at: Date }): 201 {
  void row;
  return 201;
}
