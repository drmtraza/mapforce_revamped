import { describe, expect, it } from 'vitest';
import type { OrgMapV2 } from '../src/types.ts';
import {
  validateAdapterResult,
  validateEventEnvelope,
  validateOrgMapGrounding,
  validateOrgMapV2,
} from '../src/index.ts';
import {
  validContactResult,
  validDiscoveryResult,
  validPeopleResult,
  validSignalsResult,
} from './fixtures.ts';

describe('validateAdapterResult', () => {
  it('accepts a well-formed result', () => {
    expect(validateAdapterResult(validPeopleResult())).toMatchObject({ ok: true });
  });

  it('rejects unknown properties (no silent extra fields)', () => {
    const r = { ...validPeopleResult(), surprise: true };
    expect(validateAdapterResult(r).ok).toBe(false);
  });

  it('rejects a claim citing evidence that is not in the payload', () => {
    const r = validPeopleResult();
    r.people[0]!.evidence_refs = ['ev-fabricated'];
    const out = validateAdapterResult(r);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join()).toMatch(/unknown evidence ref ev-fabricated/);
  });

  it('rejects people without evidence', () => {
    const r = validPeopleResult();
    r.people[0]!.evidence_refs = [];
    expect(validateAdapterResult(r).ok).toBe(false);
  });

  it('rejects a model inference marked verified', () => {
    const r = validPeopleResult();
    r.relationships[0]!.claim_type = 'model_inference';
    expect(validateAdapterResult(r).ok).toBe(false);
  });

  it('rejects relationships to unknown people', () => {
    const r = validPeopleResult();
    r.relationships[0]!.object_ref = 'p-ghost';
    expect(validateAdapterResult(r).ok).toBe(false);
  });

  it('rejects confidence outside 0..1 and malformed hashes', () => {
    const a = validPeopleResult();
    a.people[0]!.confidence = 1.2;
    expect(validateAdapterResult(a).ok).toBe(false);
    const b = validPeopleResult();
    b.evidence[0]!.content_hash = 'md5:abc';
    expect(validateAdapterResult(b).ok).toBe(false);
  });

  it('rejects failed results that still carry data, and accepts clean failures', () => {
    const r = validPeopleResult();
    r.status = 'failed';
    r.error = { code: 'SOURCE_UNAVAILABLE', message: 'down', retryable: true };
    expect(validateAdapterResult(r).ok).toBe(false);
    const clean = {
      ...r,
      evidence: [],
      people: [],
      relationships: [],
      company_claims: [],
    };
    expect(validateAdapterResult(clean).ok).toBe(true);
  });

  it('rejects non-http evidence URLs', () => {
    const r = validPeopleResult();
    r.evidence[0]!.source_url = 'file:///etc/passwd';
    expect(validateAdapterResult(r).ok).toBe(false);
  });
});

describe('validateAdapterResult (discover_companies)', () => {
  it('accepts candidate companies with cited evidence', () => {
    expect(validateAdapterResult(validDiscoveryResult()).ok).toBe(true);
  });

  it('rejects candidates without resolvable evidence', () => {
    const r = validDiscoveryResult();
    r.companies![0]!.evidence_refs = ['ev-missing'];
    expect(validateAdapterResult(r).ok).toBe(false);
  });

  it('rejects malformed or non-lowercase domains, and URL-shaped domains', () => {
    for (const domain of [
      'Northwind.EXAMPLE',
      'https://x.example',
      'localhost',
      'x.example/path',
    ]) {
      const r = validDiscoveryResult();
      r.companies![0]!.domain = domain;
      expect(validateAdapterResult(r).ok, domain).toBe(false);
    }
  });

  it('rejects candidates labelled as model inference', () => {
    const r = validDiscoveryResult() as unknown as { companies: { claim_type: string }[] };
    r.companies[0]!.claim_type = 'model_inference';
    expect(validateAdapterResult(r).ok).toBe(false);
  });

  it('rejects duplicate domains and candidates on other operations', () => {
    const dup = validDiscoveryResult();
    dup.companies!.push({ ...dup.companies![0]!, ref: 'c-2' });
    expect(validateAdapterResult(dup).ok).toBe(false);
    const wrongOp = validDiscoveryResult();
    wrongOp.operation = 'fetch_company_evidence';
    expect(validateAdapterResult(wrongOp).ok).toBe(false);
  });

  it('still accepts v1 payloads without the optional companies array', () => {
    const r = validPeopleResult();
    expect('companies' in r).toBe(false);
    expect(validateAdapterResult(r).ok).toBe(true);
  });
});

describe('validateAdapterResult (signals and contacts)', () => {
  it('accepts hiring signals that do not imply budget', () => {
    expect(validateAdapterResult(validSignalsResult()).ok).toBe(true);
  });

  it('rejects hiring signals marked as implying budget', () => {
    const r = validSignalsResult();
    r.signals![0]!.implies_budget = true;
    expect(validateAdapterResult(r).ok).toBe(false);
  });

  it('rejects signals on other operations', () => {
    const r = validSignalsResult();
    r.operation = 'fetch_company_evidence';
    expect(validateAdapterResult(r).ok).toBe(false);
  });

  it('accepts pattern emails labelled unverified', () => {
    expect(validateAdapterResult(validContactResult()).ok).toBe(true);
  });

  it('rejects a guessed address labelled provider_verified', () => {
    const r = validContactResult();
    r.contact_points![0]!.status = 'provider_verified';
    r.contact_points![0]!.verified_at = '2026-10-01T00:00:00Z';
    expect(validateAdapterResult(r).ok).toBe(false);
  });

  it('rejects provider_verified without a method and timestamp', () => {
    const r = validContactResult();
    r.operation = 'enrich_contact';
    r.contact_points![0]!.status = 'provider_verified';
    r.contact_points![0]!.verification_method = 'provider';
    r.contact_points![0]!.verified_at = null;
    expect(validateAdapterResult(r).ok).toBe(false);
  });

  it('rejects contacts on other operations', () => {
    const r = validContactResult();
    r.operation = 'discover_people';
    expect(validateAdapterResult(r).ok).toBe(false);
  });

  it('still accepts v1 payloads without signals or contact_points', () => {
    const r = validPeopleResult();
    expect('signals' in r).toBe(false);
    expect('contact_points' in r).toBe(false);
    expect(validateAdapterResult(r).ok).toBe(true);
  });
});

describe('validateOrgMapV2', () => {
  const base = {
    schema_version: 2,
    company_id: 'c1',
    people: [{ person_id: 'p1', persona: 'unknown', confidence: 0.5, evidence_ids: ['e1'] }],
    relationships: [],
    unknowns: [],
    conflicts: [],
  };

  it('accepts a minimal map', () => {
    expect(validateOrgMapV2(base).ok).toBe(true);
  });

  it('requires rationale on relationships', () => {
    const map = {
      ...base,
      relationships: [
        {
          subject_person_id: 'p1',
          predicate: 'REPORTS_TO',
          object_person_id: 'p2',
          status: 'inferred',
          claim_type: 'model_inference',
          confidence: 0.6,
          evidence_ids: ['e1'],
        },
      ],
    };
    expect(validateOrgMapV2(map).ok).toBe(false);
  });

  it('rejects fabricated people, emails and unverifiable model edges', () => {
    const map = {
      ...base,
      people: [
        {
          person_id: 'ghost',
          persona: 'economic_buyer',
          confidence: 0.8,
          evidence_ids: ['e1'],
          outreach_angle: {
            value: 'Email jane@acme.example about budget',
            claim_type: 'model_inference',
            confidence: 0.5,
            evidence_ids: ['e1'],
            rationale: 'invented',
          },
        },
      ],
      relationships: [
        {
          subject_person_id: 'p1',
          predicate: 'REPORTS_TO',
          object_person_id: 'p1',
          status: 'inferred',
          claim_type: 'model_inference',
          confidence: 0.9,
          evidence_ids: ['missing'],
          rationale: 'because I said so',
        },
      ],
    };
    const out = validateOrgMapGrounding(map as OrgMapV2, {
      companyId: 'c1',
      personIds: ['p1'],
      evidenceIds: ['e1'],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.join()).toMatch(/unknown person_id/);
      expect(out.errors.join()).toMatch(/email address/);
      expect(out.errors.join()).toMatch(/unknown evidence_id|self-relationship/);
    }
  });

  it('accepts a grounded overlay', () => {
    const map = {
      ...base,
      people: [{ person_id: 'p1', persona: 'procurement', confidence: 0.6, evidence_ids: ['e1'] }],
    };
    expect(
      validateOrgMapGrounding(map as OrgMapV2, {
        companyId: 'c1',
        personIds: ['p1'],
        evidenceIds: ['e1'],
      }).ok,
    ).toBe(true);
  });

  it('requires cited evidence on outreach angles', () => {
    const map = {
      ...base,
      people: [
        {
          ...base.people[0],
          outreach_angle: {
            value: 'x',
            claim_type: 'model_inference',
            confidence: 0.5,
            evidence_ids: [],
            rationale: 'r',
          },
        },
      ],
    };
    expect(validateOrgMapV2(map).ok).toBe(false);
  });
});

describe('validateEventEnvelope', () => {
  it('accepts a documented envelope', () => {
    expect(
      validateEventEnvelope({
        event_id: '7d1c8f53-4a52-4cf8-9b1e-0f7f0f7f0f7f',
        event_type: 'research.company.requested',
        schema_version: 1,
        occurred_at: '2026-01-01T00:00:00Z',
        tenant_id: '7d1c8f53-4a52-4cf8-9b1e-0f7f0f7f0f70',
        correlation_id: 'trace',
        idempotency_key: 'k',
        payload: {},
      }).ok,
    ).toBe(true);
  });
});
