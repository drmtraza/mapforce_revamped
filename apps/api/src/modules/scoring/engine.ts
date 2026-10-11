import type { Persona } from '@mapforce/contracts';
import { personaFromTitle } from '../ai/taxonomy.ts';
import type { ScoringWeights } from './weights.ts';

export interface IcpForScore {
  industries: string[];
  countries: string[];
  employee_bands: string[];
  target_personas: Persona[];
  signals: string[];
  excluded_domains: string[];
}

export interface ScoreInput {
  company: {
    id: string;
    domain: string;
    industry: string | null;
    country_code: string | null;
    employee_band: string | null;
    description: string | null;
  };
  people: { title: string | null; persona?: Persona | null }[];
  signals: { signal_type: string; implies_budget: boolean; observed_at: string }[];
  evidence_count: number;
  source_count: number;
  suppressed: boolean;
}

export interface ScoreFactor {
  key: keyof ScoringWeights;
  value: number;
  max: number;
  rationale: string;
}

export interface ScoreResult {
  total: number;
  eligible: boolean;
  suppression_override: boolean;
  factors: ScoreFactor[];
  explanation: string;
}

function share(weight: number, ratio: number): number {
  return Math.round(weight * Math.min(1, Math.max(0, ratio)));
}

function icpFit(company: ScoreInput['company'], icp: IcpForScore, max: number): ScoreFactor {
  if (icp.excluded_domains.includes(company.domain)) {
    return { key: 'icp_fit', value: 0, max, rationale: 'Domain is excluded by the ICP.' };
  }
  const checks: { ok: boolean; label: string }[] = [];
  if (icp.industries.length) {
    checks.push({
      ok: Boolean(company.industry && icp.industries.includes(company.industry)),
      label: 'industry',
    });
  }
  if (icp.countries.length) {
    checks.push({
      ok: Boolean(company.country_code && icp.countries.includes(company.country_code)),
      label: 'country',
    });
  }
  if (icp.employee_bands.length) {
    checks.push({
      ok: Boolean(company.employee_band && icp.employee_bands.includes(company.employee_band)),
      label: 'employee band',
    });
  }
  if (checks.length === 0) {
    return {
      key: 'icp_fit',
      value: share(max, company.industry || company.country_code ? 0.5 : 0),
      max,
      rationale:
        'ICP has no industry/country/band constraints; partial credit for a filled profile.',
    };
  }
  const hits = checks.filter((c) => c.ok).length;
  return {
    key: 'icp_fit',
    value: share(max, hits / checks.length),
    max,
    rationale: `${hits}/${checks.length} ICP constraints matched (${checks.map((c) => c.label).join(', ')}).`,
  };
}

function roleFit(people: ScoreInput['people'], icp: IcpForScore, max: number): ScoreFactor {
  const personas = people.map((p) => p.persona ?? personaFromTitle(p.title));
  const targets = icp.target_personas;
  const matches = targets.length
    ? personas.filter((p) => p !== 'unknown' && targets.includes(p)).length
    : personas.filter((p) => p !== 'unknown').length;
  const ratio = matches === 0 ? 0 : matches === 1 ? 0.6 : 1;
  return {
    key: 'role_relevance',
    value: share(max, ratio),
    max,
    rationale: targets.length
      ? `${matches} people match ICP target personas.`
      : `${matches} people have a classified buying-unit persona.`,
  };
}

function intentFit(signals: ScoreInput['signals'], icp: IcpForScore, max: number): ScoreFactor {
  const wanted = icp.signals;
  const relevant = signals.filter((s) => (wanted.length ? wanted.includes(s.signal_type) : true));
  if (relevant.length === 0) {
    return { key: 'intent', value: 0, max, rationale: 'No matching intent signals on file.' };
  }
  const now = Date.now();
  let best = 0;
  for (const s of relevant) {
    const ageDays = Math.max(0, (now - Date.parse(s.observed_at)) / 86_400_000);
    const recency = ageDays <= 30 ? 1 : ageDays <= 90 ? 0.7 : 0.4;
    best = Math.max(best, recency);
  }
  return {
    key: 'intent',
    value: share(max, best),
    max,
    rationale: `${relevant.length} matching signal(s); hiring is not treated as approved budget.`,
  };
}

function completeness(input: ScoreInput, max: number): ScoreFactor {
  const flags = [
    Boolean(input.company.description),
    Boolean(input.company.industry),
    Boolean(input.company.country_code),
    input.evidence_count > 0,
    input.people.length > 0,
  ];
  const hits = flags.filter(Boolean).length;
  return {
    key: 'completeness',
    value: share(max, hits / flags.length),
    max,
    rationale: `${hits}/5 profile completeness checks passed.`,
  };
}

function corroboration(sourceCount: number, max: number): ScoreFactor {
  const ratio = sourceCount <= 0 ? 0 : sourceCount === 1 ? 0.4 : sourceCount === 2 ? 0.7 : 1;
  return {
    key: 'corroboration',
    value: share(max, ratio),
    max,
    rationale: `${sourceCount} distinct source(s) contributed evidence.`,
  };
}

/** Deterministic 0–100 score. Suppression and ICP exclusions always win. */
export function scoreCompany(
  input: ScoreInput,
  icp: IcpForScore,
  weights: ScoringWeights,
): ScoreResult {
  const excluded = icp.excluded_domains.includes(input.company.domain);
  const factors = [
    icpFit(input.company, icp, weights.icp_fit),
    roleFit(input.people, icp, weights.role_relevance),
    intentFit(input.signals, icp, weights.intent),
    completeness(input, weights.completeness),
    corroboration(input.source_count, weights.corroboration),
  ];
  const raw = factors.reduce((n, f) => n + f.value, 0);
  if (input.suppressed || excluded) {
    return {
      total: 0,
      eligible: false,
      suppression_override: true,
      factors,
      explanation: input.suppressed
        ? 'Suppression overrides scoring, lists, export and outreach.'
        : 'ICP excluded domain overrides scoring.',
    };
  }
  return {
    total: Math.min(100, raw),
    eligible: true,
    suppression_override: false,
    factors,
    explanation: `Explainable ICP score ${Math.min(100, raw)}/100. Confidence is a heuristic, not a probability.`,
  };
}
