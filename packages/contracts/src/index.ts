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
  const errors: string[] = [];

  if (r.status === 'failed') {
    if (r.error === null) errors.push('/error required when status is failed');
    if (r.evidence.length || r.company_claims.length || r.people.length || r.relationships.length) {
      errors.push('/status failed results must not carry data');
    }
  } else if (r.error !== null) {
    errors.push('/error must be null when status is succeeded');
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
  r.people.forEach((p, i) => checkEvidence(`/people/${i}`, p.evidence_refs));
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

export function validateEventEnvelope(data: unknown): ValidationResult<EventEnvelope> {
  return run(validators.eventEnvelope, data);
}
