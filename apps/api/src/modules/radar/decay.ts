/**
 * Opportunity Radar freshness decay + fingerprinting.
 * Heuristic only — not buying intent. claim_type must stay on the opportunity.
 */

export type OpportunityKind = 'signal' | 'product_match' | 'announcement';

/** Half-life in days by kind (announcements decay fastest). */
const HALF_LIFE_DAYS: Record<OpportunityKind, number> = {
  announcement: 7,
  signal: 14,
  product_match: 21,
};

export function ageDays(observedAt: Date, now: Date = new Date()): number {
  return Math.max(0, (now.getTime() - observedAt.getTime()) / 86_400_000);
}

/** Exponential decay to 0–100. Old announcements fall quickly. */
export function freshnessScore(
  kind: OpportunityKind,
  observedAt: Date,
  now: Date = new Date(),
): number {
  const half = HALF_LIFE_DAYS[kind];
  const age = ageDays(observedAt, now);
  const raw = 100 * Math.exp((-Math.LN2 * age) / half);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable dedupe key within a tenant (company + kind + normalized title). */
export function opportunityFingerprint(
  companyId: string,
  kind: OpportunityKind,
  title: string,
): string {
  const base = `${companyId}|${kind}|${normalizeTitle(title)}`;
  let h = 2166136261;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  // Length ≥16 for DB check; include a readable prefix for ops.
  return `fp_${kind.slice(0, 3)}_${hex}_${companyId.replace(/-/g, '').slice(0, 8)}`;
}

export function claimTypeLabel(
  claimType: 'source_fact' | 'provider_fact' | 'model_inference' | 'user_assertion',
): string {
  switch (claimType) {
    case 'source_fact':
    case 'provider_fact':
      return 'verified_source';
    case 'model_inference':
      return 'model_inference';
    case 'user_assertion':
      return 'user_assertion';
  }
}
