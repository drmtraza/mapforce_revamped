import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';

export const IcpDefinition = z
  .object({
    industries: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code'))
      .max(50)
      .default([]),
    employee_bands: z
      .array(z.enum(['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001+']))
      .max(7)
      .default([]),
    target_personas: z
      .array(
        z.enum([
          'economic_buyer',
          'functional_champion',
          'technical_evaluator',
          'operational_user',
          'procurement',
        ]),
      )
      .max(5)
      .default([]),
    target_titles: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    signals: z
      .array(
        z.enum([
          'hiring',
          'funding',
          'procurement',
          'expansion',
          'leadership_change',
          'product_launch',
          'technology_footprint',
          'regulatory_filing',
          'news',
        ]),
      )
      .max(9)
      .default([]),
    excluded_domains: z.array(z.string().trim().min(3).max(253)).max(500).default([]),
  })
  .strict();

const IcpProfile = z.object({
  id: z.string(),
  profile_key: z.string(),
  name: z.string(),
  version: z.number(),
  definition: IcpDefinition,
  active: z.boolean(),
  created_by: z.string(),
  created_at: z.string(),
});

type Row = {
  id: string;
  profile_key: string;
  name: string;
  version: number;
  definition: unknown;
  active: boolean;
  created_by: string;
  created_at: Date;
};

const toDto = (r: Row) => ({
  ...r,
  definition: IcpDefinition.parse(r.definition),
  created_at: r.created_at.toISOString(),
});

const COLUMNS = [
  'id',
  'profile_key',
  'name',
  'version',
  'definition',
  'active',
  'created_by',
  'created_at',
] as const;

export const icpRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/icp-profiles',
      {
        schema: { tags: ['icp'], response: { 200: z.object({ data: z.array(IcpProfile) }) } },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'icp.read');
        const rows = await withContext(db, ctx, (trx) =>
          trx
            .selectFrom('icp_profiles')
            .select(COLUMNS)
            .where('tenant_id', '=', ctx.tenantId)
            .where('active', '=', true)
            .orderBy('created_at', 'desc')
            .limit(100)
            .execute(),
        );
        return { data: rows.map(toDto) };
      },
    );

    app.post(
      '/icp-profiles',
      {
        schema: {
          tags: ['icp'],
          body: z.object({ name: z.string().trim().min(1).max(120), definition: IcpDefinition }),
          response: { 201: IcpProfile },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'icp.write');
        const row = await withContext(db, ctx, async (trx) => {
          const created = await trx
            .insertInto('icp_profiles')
            .values({
              tenant_id: ctx.tenantId,
              profile_key: randomUUID(),
              name: request.body.name,
              version: 1,
              definition: JSON.stringify(request.body.definition),
              created_by: ctx.userId,
            })
            .returning(COLUMNS)
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'icp.created',
            entityType: 'icp_profile',
            entityId: created.profile_key,
            correlationId: ctx.correlationId,
            metadata: { version: 1 },
          });
          return created;
        });
        return reply.status(201).send(toDto(row));
      },
    );

    app.patch(
      '/icp-profiles/:id',
      {
        schema: {
          tags: ['icp'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            expected_version: z.number().int().min(1),
            name: z.string().trim().min(1).max(120).optional(),
            definition: IcpDefinition.optional(),
          }),
          response: { 200: IcpProfile },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'icp.write');
        const row = await withContext(db, ctx, async (trx) => {
          const current = await trx
            .selectFrom('icp_profiles')
            .select(COLUMNS)
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!current) throw notFound('ICP profile');
          if (!current.active || current.version !== request.body.expected_version) {
            throw new AppError('CONFLICT', 'ICP profile was modified; reload and retry.');
          }
          await trx
            .updateTable('icp_profiles')
            .set({ active: false })
            .where('id', '=', current.id)
            .execute();
          const next = await trx
            .insertInto('icp_profiles')
            .values({
              tenant_id: ctx.tenantId,
              profile_key: current.profile_key,
              name: request.body.name ?? current.name,
              version: current.version + 1,
              definition: JSON.stringify(request.body.definition ?? current.definition),
              created_by: ctx.userId,
            })
            .returning(COLUMNS)
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'icp.updated',
            entityType: 'icp_profile',
            entityId: current.profile_key,
            correlationId: ctx.correlationId,
            metadata: { from_version: current.version, to_version: next.version },
          });
          return next;
        });
        return toDto(row);
      },
    );
  };
