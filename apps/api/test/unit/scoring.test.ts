import { describe, expect, it } from 'vitest';
import { scoreCompany } from '../../src/modules/scoring/engine.ts';
import { DEFAULT_WEIGHTS, parseWeights } from '../../src/modules/scoring/weights.ts';
import { csvCell, toCsv } from '../../src/modules/exports/csv.ts';

const icp = {
  industries: ['Software'],
  countries: ['GB'],
  employee_bands: ['51-200'],
  target_personas: ['technical_evaluator' as const],
  signals: ['hiring'],
  excluded_domains: ['blocked.example'],
};

const base = {
  company: {
    id: 'c1',
    domain: 'acme.example',
    industry: 'Software',
    country_code: 'GB',
    employee_band: '51-200',
    description: 'Widgets',
  },
  people: [{ title: 'VP Engineering' }],
  signals: [
    { signal_type: 'hiring', implies_budget: false, observed_at: new Date().toISOString() },
  ],
  evidence_count: 3,
  source_count: 2,
  suppressed: false,
};

describe('parseWeights', () => {
  it('requires a 100 total', () => {
    expect(() => parseWeights({ ...DEFAULT_WEIGHTS, icp_fit: 31 })).toThrow(/sum to 100/);
    expect(parseWeights(DEFAULT_WEIGHTS)).toEqual(DEFAULT_WEIGHTS);
  });
});

describe('scoreCompany', () => {
  it('returns an explainable 0–100 score', () => {
    const out = scoreCompany(base, icp, DEFAULT_WEIGHTS);
    expect(out.eligible).toBe(true);
    expect(out.total).toBeGreaterThan(50);
    expect(out.total).toBeLessThanOrEqual(100);
    expect(out.factors).toHaveLength(5);
    expect(out.explanation).toMatch(/heuristic/);
  });

  it('suppression overrides score to zero and ineligible', () => {
    const out = scoreCompany({ ...base, suppressed: true }, icp, DEFAULT_WEIGHTS);
    expect(out.total).toBe(0);
    expect(out.eligible).toBe(false);
    expect(out.suppression_override).toBe(true);
    expect(out.explanation).toMatch(/Suppression overrides/);
  });

  it('excluded domains override scoring', () => {
    const out = scoreCompany(
      { ...base, company: { ...base.company, domain: 'blocked.example' } },
      icp,
      DEFAULT_WEIGHTS,
    );
    expect(out.eligible).toBe(false);
    expect(out.total).toBe(0);
  });
});

describe('csv formula safety', () => {
  it('prefixes formula-like cells', () => {
    expect(csvCell('=CMD()')).toBe(`"'=CMD()"`);
    expect(csvCell('+1+1')).toBe(`"'+1+1"`);
    expect(csvCell('Acme')).toBe(`"Acme"`);
  });

  it('emits a csv with quoted headers', () => {
    const csv = toCsv(['name', 'domain'], [['=HYPERLINK("x")', 'acme.example']]);
    expect(csv).toMatch(/"'=HYPERLINK/);
    expect(csv).not.toMatch(/^[=+\-@]/m);
  });
});
