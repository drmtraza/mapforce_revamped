import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { decodeCursor, PageMeta, PageQuery, paginate } from '../../http/pagination.ts';
import { recordAudit } from '../audit/service.ts';
import { loadCompany } from '../companies/routes.ts';
import { keyBelongsToTenant } from './storage.ts';

export const Evidence = z.object({
  id: z.string(),
  source_key: z.string(),
  provider_name: z.string(),
  source_type: z.string(),
  is_mock: z.boolean(),
  source_url: z.string(),
  fetched_at: z.string(),
  published_at: z.string().nullable(),
  content_hash: z.string(),
  content_type: z.string(),
  excerpt: z.string().nullable(),
  has_stored_content: z.boolean(),
  workflow_job_id: z.string().nullable(),
  created_at: z.string(),
});

export const evidenceRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, storage, config } = deps;

    app.get(
      '/companies/:id/evidence',
      {
        schema: {
          tags: ['evidence'],
          params: z.object({ id: z.uuid() }),
          querystring: PageQuery,
          response: { 200: z.object({ data: z.array(Evidence), ...PageMeta }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'evidence.read');
        const { limit } = request.query;
        const cursor = decodeCursor(request.query.cursor);
        const rows = await withContext(db, ctx, async (trx) => {
          await loadCompany(trx, ctx.tenantId, request.params.id);
          let q = trx
            .selectFrom('evidence_records as e')
            .innerJoin('source_registry as s', 's.id', 'e.source_registry_id')
            .select([
              'e.id',
              'e.source_registry_id as source_key',
              's.provider_name',
              's.source_type',
              's.is_mock',
              'e.source_url',
              'e.fetched_at',
              'e.published_at',
              'e.content_hash',
              'e.content_type',
              'e.excerpt',
              'e.storage_key',
              'e.workflow_job_id',
              'e.created_at',
            ])
            .where('e.tenant_id', '=', ctx.tenantId)
            .where('e.company_id', '=', request.params.id);
          if (cursor) {
            q = q.where((eb) =>
              eb.or([
                eb('e.created_at', '<', new Date(cursor.t)),
                eb.and([eb('e.created_at', '=', new Date(cursor.t)), eb('e.id', '<', cursor.id)]),
              ]),
            );
          }
          return q
            .orderBy('e.created_at', 'desc')
            .orderBy('e.id', 'desc')
            .limit(limit + 1)
            .execute();
        });
        const { page, ...meta } = paginate(rows, limit);
        return {
          data: page.map(({ storage_key, ...r }) => ({
            ...r,
            fetched_at: r.fetched_at.toISOString(),
            published_at: r.published_at?.toISOString() ?? null,
            created_at: r.created_at.toISOString(),
            has_stored_content: storage_key !== null,
          })),
          ...meta,
        };
      },
    );

    app.get(
      '/evidence/:id/content-url',
      {
        schema: {
          tags: ['evidence'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ url: z.string(), expires_in_seconds: z.number() }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'evidence.read');
        const key = await withContext(db, ctx, async (trx) => {
          const row = await trx
            .selectFrom('evidence_records')
            .select(['id', 'storage_key'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!row?.storage_key || !keyBelongsToTenant(row.storage_key, ctx.tenantId)) {
            throw notFound('Evidence content');
          }
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'evidence.content_accessed',
            entityType: 'evidence',
            entityId: row.id,
            correlationId: ctx.correlationId,
          });
          return row.storage_key;
        });
        const ttl = config.EVIDENCE_URL_TTL_SECONDS;
        return { url: await storage.signedGetUrl(key, ttl), expires_in_seconds: ttl };
      },
    );
  };
