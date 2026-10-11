export type ConfidenceBand = 'strong' | 'plausible' | 'weak' | 'very_weak';

const EXPLANATIONS: Record<ConfidenceBand, string> = {
  strong: 'Strong corroboration across independent sources; human review is still available.',
  plausible: 'Plausible and partially corroborated; treat as inferred until confirmed.',
  weak: 'Weak evidence; do not use as a primary targeting fact.',
  very_weak: 'Insufficient evidence; route to research rather than outreach.',
};

/**
 * Maps a heuristic confidence score to the documented bands. Scores are not
 * calibrated probabilities until evaluated against a labelled set.
 */
export function confidenceBand(value: number): { band: ConfidenceBand; explanation: string } {
  const band: ConfidenceBand =
    value >= 0.85 ? 'strong' : value >= 0.65 ? 'plausible' : value >= 0.4 ? 'weak' : 'very_weak';
  return {
    band,
    explanation: `${EXPLANATIONS[band]} Score is a heuristic, not a calibrated probability.`,
  };
}
