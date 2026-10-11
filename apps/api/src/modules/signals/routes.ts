import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { requireTenant } from '../../http/context.ts';
import { loadCompany } from '../companies/routes.ts';
import { confidenceBand } from '../people/confidence.ts';

const Signal = z.object({
  id: z.string(),
  signal_type: z.string(),
  title: z.string(),
  summary: z.string(),
  implies_budget: z.boolean(),
  claim_type: z.enum(['source_fact', 'provider_fact', 'model_inference', 'user_assertion']),
  confidence: z.object({
    value: z.number(),
    band: z.enum(['strong', 'plausible', 'weak', 'very_weak']),
    explanation: z.string(),
  }),
  country_code: z.string().nullable(),
  observed_at: z.string(),
  source_key: z.string(),
  evidence: z.array(
    z.object({
      id: z.string(),
      source_url: z.string(),
      excerpt: z.string().nullable(),
    }),
  ),
});

export const signalRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/companies/:id/signals',
      {
        schema: {
          tags: ['signals'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ data: z.array(Signal) }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        return withContext(db, ctx, async (trx) => {
          await loadCompany(trx, ctx.tenantId, request.params.id);
          const rows = await trx
            .selectFrom('intent_signals')
            .select([
              'id',
              'signal_type',
              'title',
              'summary',
              'implies_budget',
              'claim_type',
              'confidence',
              'country_code',
              'observed_at',
              'source_key',
            ])
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', request.params.id)
            .orderBy('observed_at', 'desc')
            .limit(100)
            .execute();
          const evidence = rows.length
            ? await trx
                .selectFrom('signal_evidence as se')
                .innerJoin('evidence_records as e', 'e.id', 'se.evidence_record_id')
                .select(['se.signal_id', 'e.id', 'e.source_url', 'e.excerpt'])
                .where('se.tenant_id', '=', ctx.tenantId)
                .where(
                  'se.signal_id',
                  'in',
                  rows.map((r) => r.id),
                )
                .execute()
            : [];
          const bySignal = new Map<
            string,
            { id: string; source_url: string; excerpt: string | null }[]
          >();
          for (const e of evidence) {
            const list = bySignal.get(e.signal_id) ?? [];
            list.push({ id: e.id, source_url: e.source_url, excerpt: e.excerpt });
            bySignal.set(e.signal_id, list);
          }
          return {
            data: rows.map((r) => ({
              id: r.id,
              signal_type: r.signal_type,
              title: r.title,
              summary: r.summary,
              implies_budget: r.implies_budget,
              claim_type: r.claim_type,
              confidence: { value: Number(r.confidence), ...confidenceBand(Number(r.confidence)) },
              country_code: r.country_code,
              observed_at: r.observed_at.toISOString(),
              source_key: r.source_key,
              evidence: bySignal.get(r.id) ?? [],
            })),
          };
        });
      },
    );
  };
