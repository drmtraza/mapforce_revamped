import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { RESEARCH_OPERATIONS } from '../../temporal/types.ts';
import { recordAudit } from '../audit/service.ts';
import { loadCompany } from '../companies/routes.ts';
import { listEffectiveSources } from './service.ts';

const Source = z.object({
  id: z.string(),
  provider_name: z.string(),
  source_type: z.string(),
  description: z.string(),
  operations: z.array(z.string()),
  terms_reference: z.string(),
  is_mock: z.boolean(),
  requires_credentials: z.boolean(),
  globally_enabled: z.boolean(),
  tenant_enabled: z.boolean(),
  tenant_setting: z.enum(['default', 'enabled', 'disabled']),
  available: z.boolean(),
  unavailable_reason: z.string().nullable(),
  freshness_ttl_hours: z.number(),
  retention_days: z.number(),
  max_requests_per_job: z.number(),
});

const Freshness = z.object({
  source_key: z.string(),
  provider_name: z.string(),
  available: z.boolean(),
  last_success_at: z.string().nullable(),
  freshness_ttl_hours: z.number(),
  stale: z.boolean(),
});

export const sourceRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, config } = deps;

    app.get(
      '/sources',
      { schema: { tags: ['sources'], response: { 200: z.object({ data: z.array(Source) }) } } },
      async (request) => {
        const ctx = await requireTenant(db, request, 'source.read');
        const data = await withContext(db, ctx, (trx) =>
          listEffectiveSources(trx, ctx.tenantId, config),
        );
        return { data };
      },
    );

    app.patch(
      '/sources/:key',
      {
        schema: {
          tags: ['sources'],
          params: z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/) }),
          body: z.object({ enabled: z.boolean() }).strict(),
          response: { 200: Source },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'source.manage');
        const { key } = request.params;
        const { enabled } = request.body;
        return withContext(db, ctx, async (trx) => {
          const before = (await listEffectiveSources(trx, ctx.tenantId, config)).find(
            (s) => s.id === key,
          );
          if (!before) throw notFound('Source');
          if (enabled && !before.globally_enabled) {
            throw new AppError(
              'INVALID_STATE',
              'This source is disabled by the platform owner and cannot be turned on.',
            );
          }
          await trx
            .insertInto('tenant_source_settings')
            .values({ tenant_id: ctx.tenantId, source_key: key, enabled, updated_by: ctx.userId })
            .onConflict((oc) =>
              oc
                .columns(['tenant_id', 'source_key'])
                .doUpdateSet({ enabled, updated_by: ctx.userId, updated_at: new Date() }),
            )
            .execute();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: enabled ? 'source.enabled' : 'source.disabled',
            entityType: 'source',
            entityId: key,
            correlationId: ctx.correlationId,
            metadata: { source_key: key, previous: before.tenant_setting },
          });
          const after = (await listEffectiveSources(trx, ctx.tenantId, config)).find(
            (s) => s.id === key,
          );
          return after as NonNullable<typeof after>;
        });
      },
    );

    app.get(
      '/companies/:id/source-freshness',
      {
        schema: {
          tags: ['sources'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ data: z.array(Freshness) }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        return withContext(db, ctx, async (trx) => {
          await loadCompany(trx, ctx.tenantId, request.params.id);
          const sources = (await listEffectiveSources(trx, ctx.tenantId, config)).filter((s) =>
            s.operations.some((op) => (RESEARCH_OPERATIONS as readonly string[]).includes(op)),
          );
          const last = await trx
            .selectFrom('workflow_job_sources as js')
            .innerJoin('workflow_jobs as j', 'j.id', 'js.job_id')
            .select(['js.source_key', (eb) => eb.fn.max('js.finished_at').as('last_success_at')])
            .where('js.tenant_id', '=', ctx.tenantId)
            .where('j.company_id', '=', request.params.id)
            .where('js.status', '=', 'succeeded')
            .groupBy('js.source_key')
            .execute();
          const bySource = new Map(last.map((r) => [r.source_key, r.last_success_at]));
          const now = Date.now();
          return {
            data: sources.map((s) => {
              const at = bySource.get(s.id) ?? null;
              const stale = !at || now - at.getTime() > s.freshness_ttl_hours * 3_600_000;
              return {
                source_key: s.id,
                provider_name: s.provider_name,
                available: s.available,
                last_success_at: at?.toISOString() ?? null,
                freshness_ttl_hours: s.freshness_ttl_hours,
                stale,
              };
            }),
          };
        });
      },
    );
  };
