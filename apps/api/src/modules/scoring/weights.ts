export const SCORING_VERSION_LABEL = 'icp-explainable/1.0.0';

export const DEFAULT_WEIGHTS = {
  icp_fit: 30,
  role_relevance: 20,
  intent: 20,
  completeness: 15,
  corroboration: 15,
} as const;

export type ScoringWeights = {
  icp_fit: number;
  role_relevance: number;
  intent: number;
  completeness: number;
  corroboration: number;
};

export function parseWeights(raw: unknown): ScoringWeights {
  const w = (raw ?? {}) as Partial<ScoringWeights>;
  const next = {
    icp_fit: Number(w.icp_fit ?? DEFAULT_WEIGHTS.icp_fit),
    role_relevance: Number(w.role_relevance ?? DEFAULT_WEIGHTS.role_relevance),
    intent: Number(w.intent ?? DEFAULT_WEIGHTS.intent),
    completeness: Number(w.completeness ?? DEFAULT_WEIGHTS.completeness),
    corroboration: Number(w.corroboration ?? DEFAULT_WEIGHTS.corroboration),
  };
  if (Object.values(next).some((n) => !Number.isInteger(n) || n < 0 || n > 100)) {
    throw new Error('Scoring weights must be integers between 0 and 100.');
  }
  if (
    next.icp_fit + next.role_relevance + next.intent + next.completeness + next.corroboration !==
    100
  ) {
    throw new Error('Scoring weights must sum to 100.');
  }
  return next;
}
