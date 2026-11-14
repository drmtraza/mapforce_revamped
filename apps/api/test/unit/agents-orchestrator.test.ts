import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_VERSION,
  runAccountIntelligence,
} from '../../src/modules/agents/orchestrator.ts';

describe('account intelligence orchestrator', () => {
  it('uses a distinct orchestrator version', () => {
    expect(ORCHESTRATOR_VERSION).toBe('account-intel/1.0.0');
  });

  it('quarantines source_fact claims without evidence', () => {
    const result = runAccountIntelligence({
      company: {
        id: 'co-1',
        name: 'Acme',
        domain: 'acme.example',
        industry: 'software',
        country_code: 'US',
        description: null,
      },
      evidence: [],
      people: [
        {
          id: 'p-1',
          display_name: 'Pat Example',
          title: 'CEO',
          evidence_ids: [],
        },
      ],
      signals: [
        {
          id: 's-1',
          signal_type: 'procurement',
          title: 'RFI',
          summary: 'Needs monitoring',
          claim_type: 'source_fact',
          evidence_ids: [],
        },
      ],
      matches: [
        {
          offering_name: 'Managed SOC',
          match_score: 72,
          note: 'Not buying intent.',
          eligible: true,
        },
      ],
    });
    expect(result.provider).toBe('deterministic');
    expect(result.quarantined_claims.some((c) => c.key === 'signal:s-1')).toBe(true);
    expect(result.sections.find((s) => s.id === 'matching')?.claims.length).toBe(1);
    expect(result.summary).toMatch(/Not buying intent|human review/i);
    expect(result.agent_trace.map((t) => t.agent)).toEqual([
      'research',
      'signals',
      'matching',
      'evidence_check',
    ]);
  });

  it('keeps verified claims when evidence ids are present', () => {
    const result = runAccountIntelligence({
      company: {
        id: 'co-1',
        name: 'Acme',
        domain: 'acme.example',
        industry: null,
        country_code: null,
        description: null,
      },
      evidence: [{ id: 'e-1', source_key: 'mock_web', excerpt: 'About Acme' }],
      people: [],
      signals: [
        {
          id: 's-1',
          signal_type: 'news',
          title: 'Launch',
          summary: 'Product launch',
          claim_type: 'source_fact',
          evidence_ids: ['e-1'],
        },
      ],
      matches: [],
    });
    expect(result.quarantined_claims).toHaveLength(0);
    expect(result.sections.find((s) => s.id === 'signals')?.claims[0]?.evidence_ids).toContain(
      'e-1',
    );
  });
});
