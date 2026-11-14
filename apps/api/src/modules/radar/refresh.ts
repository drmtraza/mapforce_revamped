import type { Tx } from '@mapforce/db';
import { freshnessScore, opportunityFingerprint, type OpportunityKind } from './decay.ts';

export interface RefreshResult {
  from_signals: number;
  from_matches: number;
  upserted: number;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function matchesFilters(
  company: { country_code: string | null; industry: string | null },
  countries: string[],
  industries: string[],
): boolean {
  if (countries.length && (!company.country_code || !countries.includes(company.country_code))) {
    return false;
  }
  if (industries.length && (!company.industry || !industries.includes(company.industry))) {
    return false;
  }
  return true;
}

/**
 * Rebuilds open radar items from intent_signals + recent eligible product matches.
 * Dedupes via fingerprint; refreshes freshness_score on existing rows.
 */
export async function refreshRadarFeed(
  trx: Tx,
  tenantId: string,
  opts: {
    countries?: string[];
    industries?: string[];
    now?: Date;
  } = {},
): Promise<RefreshResult> {
  const now = opts.now ?? new Date();
  const countries = opts.countries ?? [];
  const industries = opts.industries ?? [];
  let fromSignals = 0;
  let fromMatches = 0;
  let upserted = 0;

  const signals = await trx
    .selectFrom('intent_signals as s')
    .innerJoin('companies as c', 'c.id', 's.company_id')
    .select([
      's.id',
      's.company_id',
      's.signal_type',
      's.title',
      's.summary',
      's.claim_type',
      's.confidence',
      's.observed_at',
      'c.country_code',
      'c.industry',
    ])
    .where('s.tenant_id', '=', tenantId)
    .where('c.tenant_id', '=', tenantId)
    .orderBy('s.observed_at', 'desc')
    .limit(500)
    .execute();

  for (const s of signals) {
    if (!matchesFilters(s, countries, industries)) continue;
    const kind: OpportunityKind =
      s.signal_type === 'news' || s.signal_type === 'product' ? 'announcement' : 'signal';
    const fingerprint = opportunityFingerprint(s.company_id, kind, s.title);
    const freshness = freshnessScore(kind, s.observed_at, now);
    await trx
      .insertInto('market_opportunities')
      .values({
        tenant_id: tenantId,
        company_id: s.company_id,
        opportunity_kind: kind,
        title: s.title,
        summary: s.summary,
        claim_type: s.claim_type,
        confidence: String(s.confidence),
        freshness_score: freshness,
        observed_at: s.observed_at,
        fingerprint,
        source_signal_id: s.id,
        status: 'open',
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'fingerprint']).doUpdateSet({
          summary: s.summary,
          claim_type: s.claim_type,
          confidence: String(s.confidence),
          freshness_score: freshness,
          observed_at: s.observed_at,
          source_signal_id: s.id,
          updated_at: now,
        }),
      )
      .execute();
    fromSignals += 1;
    upserted += 1;
  }

  const matches = await trx
    .selectFrom('opportunity_match_results as r')
    .innerJoin('opportunity_match_runs as run', 'run.id', 'r.run_id')
    .innerJoin('product_offerings as o', 'o.id', 'r.offering_id')
    .innerJoin('companies as c', 'c.id', 'r.company_id')
    .select([
      'r.id',
      'r.company_id',
      'r.match_score',
      'r.confidence',
      'r.eligible',
      'r.note',
      'r.created_at',
      'o.name as offering_name',
      'c.country_code',
      'c.industry',
    ])
    .where('r.tenant_id', '=', tenantId)
    .where('r.eligible', '=', true)
    .where('r.match_score', '>=', 50)
    .orderBy('r.created_at', 'desc')
    .limit(200)
    .execute();

  for (const m of matches) {
    if (!matchesFilters(m, countries, industries)) continue;
    const kind: OpportunityKind = 'product_match';
    const title = `Catalogue fit: ${m.offering_name}`;
    const fingerprint = opportunityFingerprint(m.company_id, kind, title);
    const freshness = freshnessScore(kind, m.created_at, now);
    const confMap = { low: 0.4, medium: 0.65, high: 0.85 } as const;
    await trx
      .insertInto('market_opportunities')
      .values({
        tenant_id: tenantId,
        company_id: m.company_id,
        opportunity_kind: kind,
        title,
        summary: m.note,
        claim_type: 'model_inference',
        confidence: String(confMap[m.confidence]),
        freshness_score: freshness,
        observed_at: m.created_at,
        fingerprint,
        source_match_result_id: m.id,
        status: 'open',
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'fingerprint']).doUpdateSet({
          summary: m.note,
          freshness_score: freshness,
          observed_at: m.created_at,
          source_match_result_id: m.id,
          updated_at: now,
        }),
      )
      .execute();
    fromMatches += 1;
    upserted += 1;
  }

  // Re-decay existing open rows that were not in this batch window.
  const stale = await trx
    .selectFrom('market_opportunities')
    .select(['id', 'opportunity_kind', 'observed_at'])
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'open')
    .execute();
  for (const row of stale) {
    const score = freshnessScore(row.opportunity_kind as OpportunityKind, row.observed_at, now);
    await trx
      .updateTable('market_opportunities')
      .set({ freshness_score: score, updated_at: now })
      .where('id', '=', row.id)
      .where('tenant_id', '=', tenantId)
      .execute();
  }

  return { from_signals: fromSignals, from_matches: fromMatches, upserted };
}

export { asStringArray as parseStringArray };
