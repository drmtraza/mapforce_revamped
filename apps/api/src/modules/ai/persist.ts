import { randomUUID } from 'node:crypto';
import type { OrgMapV2 } from '@mapforce/contracts';
import type { Tx } from '@mapforce/db';
import { hashContactValue } from '../contacts/crypto.ts';
import type { DeduceResult } from './types.ts';

export async function persistAiRun(
  trx: Tx,
  input: {
    tenantId: string;
    companyId: string;
    jobId: string;
    result: DeduceResult;
  },
): Promise<string> {
  const runId = randomUUID();
  await trx
    .insertInto('ai_runs')
    .values({
      id: runId,
      tenant_id: input.tenantId,
      company_id: input.companyId,
      workflow_job_id: input.jobId,
      provider: input.result.provider,
      prompt_version: 'b2b_org_deducer/1.0.0',
      model: input.result.model,
      status: input.result.status === 'failed' ? 'failed' : input.result.status,
      validation_outcome: input.result.validation,
      token_count: input.result.tokenCount,
      duration_ms: input.result.durationMs,
      evidence_ids: input.result.evidenceIds,
      result: JSON.stringify(input.result.map),
      error_code: input.result.quarantine?.reason ?? null,
      error_summary: input.result.quarantine?.errors.slice(0, 5).join('; ') ?? null,
    })
    .execute();

  if (input.result.quarantine) {
    await trx
      .insertInto('ai_quarantine')
      .values({
        tenant_id: input.tenantId,
        ai_run_id: runId,
        reason: input.result.quarantine.reason.slice(0, 2000),
        raw_excerpt: input.result.quarantine.rawExcerpt.slice(0, 4000),
        errors: JSON.stringify(input.result.quarantine.errors),
      })
      .execute();
  }

  await persistInferredRelationships(trx, input.tenantId, input.jobId, input.result.map);
  await persistOutreachDrafts(trx, input.tenantId, input.companyId, runId, input.result.map);
  return runId;
}

async function persistInferredRelationships(
  trx: Tx,
  tenantId: string,
  jobId: string,
  map: OrgMapV2,
): Promise<void> {
  for (const rel of map.relationships) {
    if (rel.claim_type !== 'model_inference') continue;
    if (rel.status === 'verified') continue;
    const existing = await trx
      .selectFrom('relationships')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('subject_type', '=', 'person')
      .where('subject_id', '=', rel.subject_person_id)
      .where('predicate', '=', rel.predicate)
      .where('object_type', '=', 'person')
      .where('object_id', '=', rel.object_person_id)
      .executeTakeFirst();
    if (existing) continue;
    const id = randomUUID();
    await trx
      .insertInto('relationships')
      .values({
        id,
        tenant_id: tenantId,
        subject_type: 'person',
        subject_id: rel.subject_person_id,
        predicate: rel.predicate,
        object_type: 'person',
        object_id: rel.object_person_id,
        status: 'inferred',
        claim_type: 'model_inference',
        confidence: rel.confidence,
        rationale: rel.rationale,
        source_key: null,
        workflow_job_id: jobId,
        valid_from: new Date(),
      })
      .execute();
    for (const evidenceId of rel.evidence_ids) {
      await trx
        .insertInto('relationship_evidence')
        .values({
          relationship_id: id,
          evidence_record_id: evidenceId,
          tenant_id: tenantId,
        })
        .onConflict((oc) => oc.columns(['relationship_id', 'evidence_record_id']).doNothing())
        .execute();
    }
  }
}

async function persistOutreachDrafts(
  trx: Tx,
  tenantId: string,
  companyId: string,
  runId: string,
  map: OrgMapV2,
): Promise<void> {
  for (const person of map.people) {
    const angle = person.outreach_angle;
    if (!angle) continue;
    const suppressed = await trx
      .selectFrom('consent_suppressions')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('subject_type', '=', 'person')
      .where('value_hash', '=', hashContactValue('person', person.person_id))
      .executeTakeFirst();
    if (suppressed) continue;
    await trx
      .insertInto('outreach_drafts')
      .values({
        tenant_id: tenantId,
        company_id: companyId,
        person_id: person.person_id,
        ai_run_id: runId,
        body: angle.value.slice(0, 2000),
        claim_type: 'model_inference',
        confidence: angle.confidence,
        evidence_ids: angle.evidence_ids,
        rationale: angle.rationale.slice(0, 2000),
        status: 'draft',
      })
      .execute();
  }
}
