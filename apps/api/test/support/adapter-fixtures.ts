import { createHash } from 'node:crypto';
import type { AdapterResult } from '@mapforce/contracts';

const hash = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const FETCHED = '2026-10-01T12:00:00Z';

const base = (sourceKey: string, operation: AdapterResult['operation']): AdapterResult => ({
  schema_version: 1,
  source_key: sourceKey,
  provider: 'mock',
  operation,
  status: 'succeeded',
  error: null,
  usage: { request_count: 1, units: 0, unit_type: 'records' },
  evidence: [],
  company_claims: [],
  people: [],
  relationships: [],
});

export function webResult(domain: string): AdapterResult {
  const excerpt = `Acme Example builds synthetic widgets. Headquartered in GB with 51-200 staff.`;
  return {
    ...base('mock_web', 'fetch_company_evidence'),
    usage: { request_count: 2, units: 2, unit_type: 'pages' },
    evidence: [
      {
        ref: 'ev-home',
        source_url: `https://${domain}/`,
        fetched_at: FETCHED,
        published_at: null,
        content_type: 'text/html',
        content_hash: hash(`${domain}:home`),
        excerpt,
        normalized_content: { title: 'Acme Example', text: excerpt },
        license_metadata: { synthetic: true },
      },
    ],
    company_claims: [
      {
        predicate: 'canonical_name',
        value: 'Acme Example Ltd',
        claim_type: 'source_fact',
        confidence: 0.9,
        evidence_refs: ['ev-home'],
      },
      {
        predicate: 'industry',
        value: 'Software',
        claim_type: 'source_fact',
        confidence: 0.7,
        evidence_refs: ['ev-home'],
      },
      {
        predicate: 'country_code',
        value: 'GB',
        claim_type: 'source_fact',
        confidence: 0.7,
        evidence_refs: ['ev-home'],
      },
    ],
  };
}

export function peopleResult(domain: string): AdapterResult {
  const excerpt =
    'Avery Example, VP Engineering. Jordan Sample, Engineering Manager, reports to Avery Example. Riley Placeholder, Head of Procurement.';
  return {
    ...base('mock_people', 'discover_people'),
    usage: { request_count: 1, units: 3, unit_type: 'records' },
    evidence: [
      {
        ref: 'ev-team',
        source_url: `https://${domain}/about/team`,
        fetched_at: FETCHED,
        published_at: null,
        content_type: 'text/html',
        content_hash: hash(`${domain}:team`),
        excerpt,
        normalized_content: { text: excerpt },
        license_metadata: { synthetic: true },
      },
    ],
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
      {
        ref: 'p-riley',
        full_name: 'Riley Placeholder',
        title: 'Head of Procurement',
        department: 'Procurement',
        seniority: 'director',
        public_profile_url: null,
        claim_type: 'source_fact',
        confidence: 0.6,
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
        confidence: 0.8,
        rationale: 'The team page states the reporting line explicitly.',
        evidence_refs: ['ev-team'],
      },
      {
        subject_ref: 'p-riley',
        predicate: 'INFLUENCES',
        object_ref: 'p-avery',
        status: 'inferred',
        claim_type: 'provider_fact',
        confidence: 0.5,
        rationale:
          'Procurement typically participates in engineering purchases; influence is not stated explicitly.',
        evidence_refs: ['ev-team'],
      },
    ],
  };
}

export function registryFailure(): AdapterResult {
  return {
    ...base('mock_registry', 'fetch_registry_record'),
    status: 'failed',
    error: { code: 'SOURCE_UNAVAILABLE', message: 'Registry returned 503', retryable: true },
    usage: { request_count: 1, units: 0, unit_type: 'records' },
  };
}
