import { describe, expect, it } from 'vitest';
import { MATCHING_VERSION, matchOffering, rankMatches } from '../../src/modules/catalogue/match.ts';

const baseOffering = {
  id: 'off-1',
  name: 'Managed SOC',
  category: 'cybersecurity',
  business_problem: 'Detect and respond to security incidents across cloud infrastructure',
  target_industries: ['financial_services'],
  target_countries: ['SA'],
  employee_bands: ['201-500'],
  target_personas: ['economic_buyer', 'technical_evaluator'],
  pricing_model: 'subscription',
  price_range_note: 'Indicative annual retainer — confirm with pricing sheet',
};

const baseCompany = {
  id: 'co-1',
  domain: 'bank.sa.example',
  industry: 'financial_services',
  country_code: 'SA',
  employee_band: '201-500',
  description: 'Regional bank',
};

describe('product-match engine', () => {
  it('uses a version distinct from ICP scoring', () => {
    expect(MATCHING_VERSION).toBe('product-match/1.0.0');
    expect(MATCHING_VERSION).not.toMatch(/icp-explainable/);
  });

  it('scores a strong catalogue fit without claiming buying intent', () => {
    const result = matchOffering({
      company: baseCompany,
      offering: baseOffering,
      people_personas: ['economic_buyer', 'technical_evaluator'],
      signals: [
        {
          signal_type: 'hiring',
          implies_budget: false,
          observed_at: new Date().toISOString(),
        },
      ],
      evidence_count: 6,
      suppressed: false,
    });
    expect(result.match_score).toBeGreaterThanOrEqual(60);
    expect(result.note).toMatch(/Not buying intent/);
    expect(result.factors.some((f) => f.key === 'commercial_potential')).toBe(true);
    expect(result.commercial_potential).toBeGreaterThan(0);
  });

  it('zeros match when suppressed', () => {
    const result = matchOffering({
      company: baseCompany,
      offering: baseOffering,
      people_personas: [],
      signals: [],
      evidence_count: 0,
      suppressed: true,
    });
    expect(result.match_score).toBe(0);
    expect(result.eligible).toBe(false);
    expect(result.suppression_override).toBe(true);
  });

  it('ranks higher scores first', () => {
    const low = matchOffering({
      company: { ...baseCompany, industry: 'other', country_code: 'XX' },
      offering: baseOffering,
      people_personas: [],
      signals: [],
      evidence_count: 0,
      suppressed: false,
    });
    const high = matchOffering({
      company: baseCompany,
      offering: baseOffering,
      people_personas: ['economic_buyer'],
      signals: [
        {
          signal_type: 'procurement',
          implies_budget: false,
          observed_at: new Date().toISOString(),
        },
      ],
      evidence_count: 8,
      suppressed: false,
    });
    expect(rankMatches([low, high])[0]?.offering_id).toBe('off-1');
    expect(rankMatches([low, high])[0]?.match_score).toBeGreaterThanOrEqual(
      rankMatches([low, high])[1]?.match_score ?? 0,
    );
  });
});
