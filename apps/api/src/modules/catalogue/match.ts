/**
 * Product-to-company opportunity matching.
 * Separate from ICP account scoring (`icp-explainable/1.0.0`).
 * Heuristic only — not buying intent or calibrated win probability.
 */
export const MATCHING_VERSION = 'product-match/1.0.0';

export type MatchConfidence = 'low' | 'medium' | 'high';

export interface OfferingForMatch {
  id: string;
  name: string;
  category: string;
  business_problem: string;
  target_industries: string[];
  target_countries: string[];
  employee_bands: string[];
  target_personas: string[];
  pricing_model: string;
  price_range_note: string | null;
}

export interface CompanyForMatch {
  id: string;
  domain: string;
  industry: string | null;
  country_code: string | null;
  employee_band: string | null;
  description: string | null;
}

export interface MatchSignal {
  signal_type: string;
  implies_budget: boolean;
  observed_at: string;
}

export interface MatchInput {
  company: CompanyForMatch;
  offering: OfferingForMatch;
  people_personas: string[];
  signals: MatchSignal[];
  evidence_count: number;
  suppressed: boolean;
}

export interface MatchFactor {
  key:
    'industry' | 'geography' | 'size' | 'persona' | 'signals' | 'evidence' | 'commercial_potential';
  value: number;
  max: number;
  rationale: string;
}

export interface MatchResult {
  offering_id: string;
  match_score: number;
  commercial_potential: number;
  confidence: MatchConfidence;
  eligible: boolean;
  suppression_override: boolean;
  factors: MatchFactor[];
  missing_information: string[];
  recommended_approach: string;
  recommended_next_action: string;
  note: string;
}

const WEIGHTS = {
  industry: 25,
  geography: 20,
  size: 15,
  persona: 15,
  signals: 15,
  evidence: 10,
} as const;

function share(max: number, ratio: number): number {
  return Math.round(max * Math.min(1, Math.max(0, ratio)));
}

function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 999;
  return Math.max(0, (now.getTime() - t) / 86_400_000);
}

function constraintFit(
  key: MatchFactor['key'],
  max: number,
  companyValue: string | null,
  targets: string[],
  label: string,
): { factor: MatchFactor; missing: string | null } {
  if (targets.length === 0) {
    return {
      factor: {
        key,
        value: share(max, companyValue ? 0.4 : 0),
        max,
        rationale: `Offering has no ${label} constraints; partial credit only.`,
      },
      missing: companyValue ? null : `Company ${label} unknown`,
    };
  }
  if (!companyValue) {
    return {
      factor: {
        key,
        value: 0,
        max,
        rationale: `Company ${label} is unknown; cannot confirm fit.`,
      },
      missing: `Company ${label} unknown`,
    };
  }
  const ok = targets.map((t) => t.toLowerCase()).includes(companyValue.toLowerCase());
  return {
    factor: {
      key,
      value: ok ? max : 0,
      max,
      rationale: ok
        ? `Company ${label} "${companyValue}" matches offering targets.`
        : `Company ${label} "${companyValue}" is outside offering targets.`,
    },
    missing: null,
  };
}

export function matchOffering(input: MatchInput, now = new Date()): MatchResult {
  const { company, offering, people_personas, signals, evidence_count, suppressed } = input;
  const missing: string[] = [];

  if (suppressed) {
    return {
      offering_id: offering.id,
      match_score: 0,
      commercial_potential: 0,
      confidence: 'low',
      eligible: false,
      suppression_override: true,
      factors: [],
      missing_information: ['Company or domain is suppressed'],
      recommended_approach: 'Do not pursue while suppression is active.',
      recommended_next_action: 'Review suppression list before any outreach.',
      note: 'Suppression overrides product matching. This is not an ICP account score.',
    };
  }

  const industry = constraintFit(
    'industry',
    WEIGHTS.industry,
    company.industry,
    offering.target_industries,
    'industry',
  );
  const geography = constraintFit(
    'geography',
    WEIGHTS.geography,
    company.country_code,
    offering.target_countries,
    'country',
  );
  const size = constraintFit(
    'size',
    WEIGHTS.size,
    company.employee_band,
    offering.employee_bands,
    'employee band',
  );
  for (const m of [industry.missing, geography.missing, size.missing]) {
    if (m) missing.push(m);
  }

  let personaFactor: MatchFactor;
  if (offering.target_personas.length === 0) {
    personaFactor = {
      key: 'persona',
      value: share(WEIGHTS.persona, people_personas.length ? 0.35 : 0),
      max: WEIGHTS.persona,
      rationale: 'Offering has no target personas; limited credit for known people.',
    };
  } else if (people_personas.length === 0) {
    personaFactor = {
      key: 'persona',
      value: 0,
      max: WEIGHTS.persona,
      rationale: 'No reviewed people/personas on the account yet.',
    };
    missing.push('No people/personas identified for persona fit');
  } else {
    const targets = new Set(offering.target_personas.map((p) => p.toLowerCase()));
    const hits = people_personas.filter((p) => targets.has(p.toLowerCase())).length;
    const ratio = hits / Math.max(1, offering.target_personas.length);
    personaFactor = {
      key: 'persona',
      value: share(WEIGHTS.persona, Math.min(1, ratio * 1.5)),
      max: WEIGHTS.persona,
      rationale:
        hits > 0
          ? `${hits} account persona(s) overlap offering targets.`
          : 'Known personas do not overlap offering targets.',
    };
  }

  const freshSignals = signals.filter((s) => daysSince(s.observed_at, now) <= 180);
  const signalTypes = new Set(freshSignals.map((s) => s.signal_type));
  const problemWords = offering.business_problem.toLowerCase();
  const categoryHint = offering.category.replace(/_/g, ' ');
  let signalHits = 0;
  if (
    signalTypes.has('hiring') &&
    /secur|cloud|ai|automat|infra|it /.test(problemWords + categoryHint)
  ) {
    signalHits += 1;
  }
  if (signalTypes.has('procurement') || signalTypes.has('tender')) signalHits += 1;
  if (signalTypes.has('expansion') || signalTypes.has('funding')) signalHits += 1;
  if (freshSignals.some((s) => s.implies_budget)) {
    // Hiring-style implies_budget false stays false; only count true when set.
    signalHits += 0;
  }
  const signalFactor: MatchFactor = {
    key: 'signals',
    value: share(WEIGHTS.signals, freshSignals.length === 0 ? 0 : Math.min(1, signalHits / 2)),
    max: WEIGHTS.signals,
    rationale:
      freshSignals.length === 0
        ? 'No fresh intent signals (≤180 days). Absence is not negative proof of demand.'
        : `${freshSignals.length} fresh signal(s); ${signalHits} loosely related to this offering. Not confirmed budget.`,
  };
  if (freshSignals.length === 0) missing.push('No recent intent signals');

  const evidenceFactor: MatchFactor = {
    key: 'evidence',
    value: share(WEIGHTS.evidence, evidence_count >= 5 ? 1 : evidence_count / 5),
    max: WEIGHTS.evidence,
    rationale:
      evidence_count === 0
        ? 'No evidence records yet; match confidence is limited.'
        : `${evidence_count} evidence record(s) available for the account.`,
  };
  if (evidence_count === 0) missing.push('No source evidence on the company');

  const factors = [
    industry.factor,
    geography.factor,
    size.factor,
    personaFactor,
    signalFactor,
    evidenceFactor,
  ];
  const match_score = Math.min(
    100,
    factors.reduce((n, f) => n + f.value, 0),
  );

  // Commercial potential is a separate heuristic — not deal value or win rate.
  const commercial_potential = Math.min(
    100,
    Math.round(
      match_score * 0.55 +
        signalFactor.value * 2 +
        (company.employee_band ? 10 : 0) +
        (offering.price_range_note ? 5 : 0),
    ),
  );
  factors.push({
    key: 'commercial_potential',
    value: commercial_potential,
    max: 100,
    rationale:
      'Heuristic blend of match strength and signal/size cues. Not a revenue forecast or calibrated win probability.',
  });

  const confidence: MatchConfidence =
    missing.length >= 3 || match_score < 35
      ? 'low'
      : missing.length === 0 && match_score >= 70
        ? 'high'
        : 'medium';

  const recommended_approach =
    match_score >= 60
      ? `Lead with "${offering.name}" if discovery confirms the stated business problem ("${offering.business_problem.slice(0, 120)}"). Cite evidence; do not claim budget.`
      : `Treat "${offering.name}" as a hypothesis only. Gather missing industry/geo/persona/signal evidence before outreach.`;

  const recommended_next_action =
    match_score >= 60
      ? 'Schedule discovery with a relevant persona; attach catalogue docs the workspace has approved.'
      : 'Complete company research and fill missing ICP fields before proposing this offering.';

  if (!offering.price_range_note) {
    missing.push('Offering has no human-authored price range note');
  }

  return {
    offering_id: offering.id,
    match_score,
    commercial_potential,
    confidence,
    eligible: match_score > 0,
    suppression_override: false,
    factors,
    missing_information: missing,
    recommended_approach,
    recommended_next_action,
    note: `Product match ${MATCHING_VERSION}. Distinct from ICP account score. Not buying intent.`,
  };
}

export function rankMatches(results: MatchResult[]): MatchResult[] {
  return [...results].sort(
    (a, b) => b.match_score - a.match_score || b.commercial_potential - a.commercial_potential,
  );
}
