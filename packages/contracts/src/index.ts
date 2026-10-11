import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { AdapterResult, EventEnvelope, OrgMapV2 } from './types.ts';

export type * from './types.ts';

export const CONTRACTS_DIR = fileURLToPath(new URL('../../../contracts/', import.meta.url));

function loadSchema(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, file), 'utf8')) as Record<string, unknown>;
}

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);

const validators = {
  adapterResult: ajv.compile<AdapterResult>(loadSchema('adapter-result.v1.schema.json')),
  orgMapV2: ajv.compile<OrgMapV2>(loadSchema('org-map.v2.schema.json')),
  eventEnvelope: ajv.compile<EventEnvelope>(loadSchema('event-envelope.v1.schema.json')),
};

export interface ValidationFailure {
  ok: false;
  errors: string[];
}
export type ValidationResult<T> = { ok: true; value: T } | ValidationFailure;

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? [])
    .slice(0, 25)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

function run<T>(fn: ValidateFunction<T>, data: unknown): ValidationResult<T> {
  return fn(data) ? { ok: true, value: data } : { ok: false, errors: formatErrors(fn.errors) };
}

/**
 * Validates an adapter payload against the JSON Schema and checks referential
 * integrity that JSON Schema cannot express (refs must resolve within the payload).
 */
export function validateAdapterResult(data: unknown): ValidationResult<AdapterResult> {
  const structural = run(validators.adapterResult, data);
  if (!structural.ok) return structural;
  const r = structural.value;
  const companies = r.companies ?? [];
  const signals = r.signals ?? [];
  const contacts = r.contact_points ?? [];
  const errors: string[] = [];

  if (r.status === 'failed') {
    if (r.error === null) errors.push('/error required when status is failed');
    if (
      r.evidence.length ||
      r.company_claims.length ||
      companies.length ||
      r.people.length ||
      r.relationships.length ||
      signals.length ||
      contacts.length
    ) {
      errors.push('/status failed results must not carry data');
    }
  } else if (r.error !== null) {
    errors.push('/error must be null when status is succeeded');
  }
  if (companies.length && r.operation !== 'discover_companies') {
    errors.push('/companies only allowed for discover_companies');
  }
  if (signals.length && r.operation !== 'fetch_intent_signals') {
    errors.push('/signals only allowed for fetch_intent_signals');
  }
  if (contacts.length && r.operation !== 'enrich_contact') {
    errors.push('/contact_points only allowed for enrich_contact');
  }

  const evidenceRefs = new Set<string>();
  for (const e of r.evidence) {
    if (evidenceRefs.has(e.ref)) errors.push(`/evidence duplicate ref ${e.ref}`);
    evidenceRefs.add(e.ref);
  }
  const personRefs = new Set<string>();
  for (const p of r.people) {
    if (personRefs.has(p.ref)) errors.push(`/people duplicate ref ${p.ref}`);
    personRefs.add(p.ref);
  }
  const checkEvidence = (path: string, refs: string[]) => {
    for (const ref of refs) {
      if (!evidenceRefs.has(ref)) errors.push(`${path} unknown evidence ref ${ref}`);
    }
  };
  r.company_claims.forEach((c, i) => checkEvidence(`/company_claims/${i}`, c.evidence_refs));
  const companyDomains = new Set<string>();
  companies.forEach((c, i) => {
    checkEvidence(`/companies/${i}`, c.evidence_refs);
    if (companyDomains.has(c.domain)) errors.push(`/companies/${i} duplicate domain ${c.domain}`);
    companyDomains.add(c.domain);
  });
  r.people.forEach((p, i) => checkEvidence(`/people/${i}`, p.evidence_refs));
  signals.forEach((s, i) => {
    checkEvidence(`/signals/${i}`, s.evidence_refs);
    if (s.signal_type === 'hiring' && s.implies_budget) {
      errors.push(`/signals/${i} hiring must not imply budget`);
    }
  });
  contacts.forEach((c, i) => {
    checkEvidence(`/contact_points/${i}`, c.evidence_refs);
    const guessed =
      c.verification_method === 'pattern' ||
      c.verification_method === 'mx' ||
      c.verification_method === 'none';
    if (guessed && c.status === 'provider_verified') {
      errors.push(`/contact_points/${i} guessed address cannot be provider_verified`);
    }
    if (
      c.status === 'provider_verified' &&
      (c.verification_method !== 'provider' || !c.verified_at)
    ) {
      errors.push(
        `/contact_points/${i} provider_verified requires method provider and verified_at`,
      );
    }
  });
  r.relationships.forEach((rel, i) => {
    checkEvidence(`/relationships/${i}`, rel.evidence_refs);
    if (!personRefs.has(rel.subject_ref)) errors.push(`/relationships/${i} unknown subject_ref`);
    if (!personRefs.has(rel.object_ref)) errors.push(`/relationships/${i} unknown object_ref`);
    if (rel.subject_ref === rel.object_ref) errors.push(`/relationships/${i} self-relationship`);
  });

  return errors.length ? { ok: false, errors } : { ok: true, value: r };
}

export function validateOrgMapV2(data: unknown): ValidationResult<OrgMapV2> {
  return run(validators.orgMapV2, data);
}

/**
 * Grounds a v2 org map against the person and evidence IDs supplied to the model.
 * Rejects fabricated people, uncited IDs, emails in outreach, and inferred-as-verified edges.
 */
export function validateOrgMapGrounding(
  map: OrgMapV2,
  allowed: { companyId: string; personIds: readonly string[]; evidenceIds: readonly string[] },
): ValidationResult<OrgMapV2> {
  const structural = validateOrgMapV2(map);
  if (!structural.ok) return structural;
  const errors: string[] = [];
  if (map.company_id !== allowed.companyId) errors.push('/company_id does not match the request');
  const people = new Set(allowed.personIds);
  const evidence = new Set(allowed.evidenceIds);
  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const seen = new Set<string>();
  map.people.forEach((p, i) => {
    if (seen.has(p.person_id)) errors.push(`/people/${i} duplicate person_id`);
    seen.add(p.person_id);
    if (!people.has(p.person_id)) errors.push(`/people/${i} unknown person_id`);
    for (const id of p.evidence_ids) {
      if (!evidence.has(id)) errors.push(`/people/${i} unknown evidence_id ${id}`);
    }
    const angle = p.outreach_angle;
    if (angle) {
      if (EMAIL.test(angle.value) || EMAIL.test(angle.rationale)) {
        errors.push(`/people/${i}/outreach_angle must not contain an email address`);
      }
      for (const id of angle.evidence_ids) {
        if (!evidence.has(id)) errors.push(`/people/${i}/outreach_angle unknown evidence_id ${id}`);
      }
    }
  });
  map.relationships.forEach((r, i) => {
    if (!people.has(r.subject_person_id) || !people.has(r.object_person_id)) {
      errors.push(`/relationships/${i} references a person not in the request`);
    }
    if (r.subject_person_id === r.object_person_id) {
      errors.push(`/relationships/${i} self-relationship`);
    }
    if (r.claim_type === 'model_inference' && r.status === 'verified') {
      errors.push(`/relationships/${i} model inference cannot be verified`);
    }
    for (const id of r.evidence_ids) {
      if (!evidence.has(id)) errors.push(`/relationships/${i} unknown evidence_id ${id}`);
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: map };
}

export function validateEventEnvelope(data: unknown): ValidationResult<EventEnvelope> {
  return run(validators.eventEnvelope, data);
}
