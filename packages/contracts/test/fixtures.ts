import type { AdapterResult } from '../src/index.ts';

const HASH = `sha256:${'a'.repeat(64)}`;

export function validPeopleResult(): AdapterResult {
  return {
    schema_version: 1,
    source_key: 'mock_people',
    provider: 'mock',
    operation: 'discover_people',
    status: 'succeeded',
    error: null,
    usage: { request_count: 1, units: 2, unit_type: 'records' },
    evidence: [
      {
        ref: 'ev-team',
        source_url: 'https://acme.example/about/team',
        fetched_at: '2026-10-01T00:00:00Z',
        published_at: null,
        content_type: 'text/html',
        content_hash: HASH,
        excerpt: 'Avery Example, VP Engineering. Jordan Sample reports to Avery Example.',
        normalized_content: { headings: ['Team'] },
        license_metadata: { synthetic: true },
      },
    ],
    company_claims: [],
    people: [
      {
        ref: 'p-avery',
        full_name: 'Avery Example',
        title: 'VP Engineering',
        department: 'Engineering',
        seniority: 'vp',
        public_profile_url: null,
        claim_type: 'source_fact',
        confidence: 0.8,
        evidence_refs: ['ev-team'],
      },
      {
        ref: 'p-jordan',
        full_name: 'Jordan Sample',
        title: 'Engineering Manager',
        department: 'Engineering',
        seniority: 'manager',
        public_profile_url: null,
        claim_type: 'source_fact',
        confidence: 0.8,
        evidence_refs: ['ev-team'],
      },
    ],
    relationships: [
      {
        subject_ref: 'p-jordan',
        predicate: 'REPORTS_TO',
        object_ref: 'p-avery',
        status: 'verified',
        claim_type: 'source_fact',
        confidence: 0.75,
        rationale: 'Team page states the reporting line explicitly.',
        evidence_refs: ['ev-team'],
      },
    ],
  };
}
