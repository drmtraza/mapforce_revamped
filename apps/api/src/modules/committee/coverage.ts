/**
 * Buying-committee coverage heuristics.
 * Does not invent reporting lines or assert budget authority without evidence.
 */

export const REQUIRED_ROLES = [
  'economic_buyer',
  'champion',
  'technical_evaluator',
  'procurement',
] as const;

export type CommitteeRole =
  | 'economic_buyer'
  | 'champion'
  | 'technical_evaluator'
  | 'procurement'
  | 'legal'
  | 'end_user'
  | 'blocker'
  | 'coach'
  | 'budget_owner'
  | 'influencer'
  | 'unknown';

export interface CoverageMember {
  committee_role: CommitteeRole;
  status: 'active' | 'dismissed';
  claim_type: string;
  evidence_ids: string[];
}

export interface CoverageResult {
  coverage_score: number;
  filled_required: string[];
  missing_required: string[];
  budget_owner_present: boolean;
  budget_owner_grounded: boolean;
  note: string;
}

function asIds(value: unknown): string[] {
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

export function computeCoverage(members: CoverageMember[]): CoverageResult {
  const active = members.filter((m) => m.status === 'active' && m.committee_role !== 'unknown');
  const byRole = new Set(active.map((m) => m.committee_role));
  const filled = REQUIRED_ROLES.filter((r) => byRole.has(r));
  const missing = REQUIRED_ROLES.filter((r) => !byRole.has(r));
  const score = Math.round((filled.length / REQUIRED_ROLES.length) * 100);

  const budgetOwners = active.filter((m) => m.committee_role === 'budget_owner');
  const budget_owner_present = budgetOwners.length > 0;
  const budget_owner_grounded = budgetOwners.every((m) => asIds(m.evidence_ids).length > 0);

  const noteParts = [
    `Coverage ${score}% of required roles (${filled.length}/${REQUIRED_ROLES.length}).`,
    missing.length ? `Missing: ${missing.join(', ')}.` : 'All required roles filled.',
    budget_owner_present
      ? budget_owner_grounded
        ? 'Budget owner present with evidence.'
        : 'Budget owner present but ungrounded evidence is not allowed.'
      : 'No budget owner classified (optional; requires evidence when set).',
    'Reporting lines are never invented by this score.',
  ];

  return {
    coverage_score: score,
    filled_required: [...filled],
    missing_required: [...missing],
    budget_owner_present,
    budget_owner_grounded,
    note: noteParts.join(' '),
  };
}

export { asIds as parseEvidenceIds };
