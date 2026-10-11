import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { resolveTenantLimits } from '../budgets/service.ts';
import { assertCapability } from '../ops/gate.ts';
import { isDomainSuppressed, isPersonSuppressed } from '../suppressions/check.ts';
import { toCsv } from './csv.ts';

const ExportResult = z.object({
  id: z.string(),
  filename: z.string(),
  row_count: z.number(),
  omitted_suppressed: z.number(),
  csv: z.string(),
  note: z.string(),
});

export const exportRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, config } = deps;

    app.post(
      '/exports',
      {
        schema: {
          tags: ['exports'],
          description: 'Formula-injection-safe CSV. Suppressed rows are omitted and audited.',
          body: z.object({
            scope: z.enum(['companies', 'list']),
            list_id: z.uuid().optional(),
          }),
          response: { 200: ExportResult },
        },
        config: { rateLimit: { max: config.RATE_LIMIT_EXPORT_PER_MINUTE } },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'export.start');
        if (request.body.scope === 'list' && !request.body.list_id) {
          throw new AppError('VALIDATION_ERROR', 'list_id is required when scope is list.');
        }
        return withContext(db, ctx, async (trx) => {
          await assertCapability(trx, ctx.tenantId, config, 'export', 'Export');
          const limits = await resolveTenantLimits(trx, ctx.tenantId, config);
          const today = await trx
            .selectFrom('export_batches')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('tenant_id', '=', ctx.tenantId)
            .where('created_at', '>=', new Date(Date.now() - 86_400_000))
            .executeTakeFirstOrThrow();
          if (Number(today.n) >= limits.export) {
            throw new AppError('QUOTA_EXCEEDED', 'Daily export limit reached for this workspace.');
          }

          const headers = ['name', 'domain_or_id', 'kind', 'score', 'eligible'];
          const rows: Array<Array<string | number | null>> = [];
          let omitted = 0;

          if (request.body.scope === 'companies') {
            const companies = await trx
              .selectFrom('companies')
              .select(['id', 'canonical_name', 'primary_domain'])
              .where('tenant_id', '=', ctx.tenantId)
              .orderBy('canonical_name')
              .limit(500)
              .execute();
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
            for (const c of companies) {
              if (await isDomainSuppressed(trx, ctx.tenantId, c.primary_domain)) {
                omitted += 1;
                continue;
              }
              const score = latest.get(c.id);
              rows.push([
                c.canonical_name,
                c.primary_domain,
                'company',
                score?.total_score ?? '',
                score ? String(score.eligible) : '',
              ]);
            }
          } else {
            const list = await trx
              .selectFrom('workspace_lists')
              .selectAll()
              .where('tenant_id', '=', ctx.tenantId)
              .where('id', '=', request.body.list_id!)
              .executeTakeFirst();
            if (!list) throw notFound('List');
            const items = await trx
              .selectFrom('list_items')
              .selectAll()
              .where('tenant_id', '=', ctx.tenantId)
              .where('list_id', '=', list.id)
              .limit(500)
              .execute();
            for (const item of items) {
              if (item.entity_type === 'company') {
                const c = await trx
                  .selectFrom('companies')
                  .select(['canonical_name', 'primary_domain'])
                  .where('tenant_id', '=', ctx.tenantId)
                  .where('id', '=', item.entity_id)
                  .executeTakeFirst();
                if (!c || (await isDomainSuppressed(trx, ctx.tenantId, c.primary_domain))) {
                  omitted += 1;
                  continue;
                }
                rows.push([c.canonical_name, c.primary_domain, 'company', '', '']);
              } else {
                const p = await trx
                  .selectFrom('people')
                  .select(['canonical_name'])
                  .where('tenant_id', '=', ctx.tenantId)
                  .where('id', '=', item.entity_id)
                  .executeTakeFirst();
                if (!p || (await isPersonSuppressed(trx, ctx.tenantId, item.entity_id))) {
                  omitted += 1;
                  continue;
                }
                rows.push([p.canonical_name, item.entity_id, 'person', '', '']);
              }
            }
          }

          const csv = toCsv(headers, rows);
          const filename = `mapforce-export-${new Date().toISOString().slice(0, 10)}.csv`;
          const batch = await trx
            .insertInto('export_batches')
            .values({
              tenant_id: ctx.tenantId,
              scope: request.body.scope,
              list_id: request.body.list_id ?? null,
              filename,
              row_count: rows.length,
              omitted_suppressed: omitted,
              created_by: ctx.userId,
            })
            .returning(['id'])
            .executeTakeFirstOrThrow();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'export.created',
            entityType: 'export',
            entityId: batch.id,
            correlationId: ctx.correlationId,
            metadata: {
              scope: request.body.scope,
              row_count: rows.length,
              omitted_suppressed: omitted,
            },
          });
          return {
            id: batch.id,
            filename,
            row_count: rows.length,
            omitted_suppressed: omitted,
            csv,
            note: 'CSV cells that look like spreadsheet formulas are quoted and prefixed. Contact values are never exported.',
          };
        });
      },
    );
  };
