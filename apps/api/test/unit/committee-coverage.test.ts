import { describe, expect, it } from 'vitest';
import { computeCoverage } from '../../src/modules/committee/coverage.ts';

describe('buying committee coverage', () => {
  it('scores required roles and notes missing ones', () => {
    const result = computeCoverage([
      {
        committee_role: 'economic_buyer',
        status: 'active',
        claim_type: 'user_assertion',
        evidence_ids: [],
      },
      {
        committee_role: 'champion',
        status: 'active',
        claim_type: 'user_assertion',
        evidence_ids: [],
      },
    ]);
    expect(result.coverage_score).toBe(50);
    expect(result.missing_required).toEqual(
      expect.arrayContaining(['technical_evaluator', 'procurement']),
    );
    expect(result.note).toMatch(/never invented/i);
  });

  it('requires evidence for grounded budget owner', () => {
    const ungrounded = computeCoverage([
      {
        committee_role: 'budget_owner',
        status: 'active',
        claim_type: 'user_assertion',
        evidence_ids: [],
      },
    ]);
    expect(ungrounded.budget_owner_present).toBe(true);
    expect(ungrounded.budget_owner_grounded).toBe(false);

    const grounded = computeCoverage([
      {
        committee_role: 'budget_owner',
        status: 'active',
        claim_type: 'source_fact',
        evidence_ids: ['e-1'],
      },
    ]);
    expect(grounded.budget_owner_grounded).toBe(true);
  });
});
