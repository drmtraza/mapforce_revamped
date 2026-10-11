import { validateAdapterResult, type AdapterCompanyCandidate } from '@mapforce/contracts';
import { withContext, type Db } from '@mapforce/db';
import { recordAudit } from '../audit/service.ts';
import { discoveryEvidenceKey, type EvidenceStorage } from '../evidence/storage.ts';
import { enqueueEvent } from '../outbox/service.ts';
import { checkUrlPolicy, recordSourceFailure, setSourceStatus } from '../research/persist.ts';
import { normalizeDomain } from '../../domain.ts';
import type { SourceOutcome } from '../../temporal/types.ts';

export interface DiscoveryPersistInput {
  tenantId: string;
  jobId: string;
  sourceKey: string;
  correlationId: string;
  attempts: number;
  result: unknown;
}

/**
 * Validates a discover_companies payload and stores its evidence and candidates.
 * Candidates are suggestions for review only; no company record is created here.
 */
export async function persistDiscoveryResult(
  db: Db,
  storage: EvidenceStorage,
  input: DiscoveryPersistInput,
): Promise<SourceOutcome> {
  const ctx = { tenantId: input.tenantId, userId: null };
  const { job, source } = await withContext(db, ctx, async (trx) => ({
    job: await trx
      .selectFrom('workflow_jobs')
      .select(['id', 'status', 'job_type'])
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.jobId)
      .executeTakeFirst(),
    source: await trx
      .selectFrom('source_registry')
      .select(['id', 'source_type', 'enabled', 'retention_days', 'operations'])
      .where('id', '=', input.sourceKey)
      .executeTakeFirst(),
  }));
  if (!job || job.job_type !== 'company_discovery') throw new Error('Discovery job not found');
  if (job.status === 'cancelled') return { sourceKey: input.sourceKey, status: 'cancelled' };
  if (!source?.enabled) {
    return recordSourceFailure(db, {
      ...input,
      errorCode: 'SOURCE_DISABLED',
      errorSummary: 'Source is not registered or is disabled.',
    });
  }

  const validation = validateAdapterResult(input.result);
  if (!validation.ok) {
    return recordSourceFailure(db, {
      ...input,
      errorCode: 'ADAPTER_PAYLOAD_INVALID',
      errorSummary: validation.errors.slice(0, 5).join('; '),
    });
  }
  const r = validation.value;
  const problems = checkUrlPolicy(r, source.source_type, null);
  if (r.source_key !== input.sourceKey) problems.push('source_key mismatch');
  if (r.operation !== 'discover_companies' || !source.operations.includes(r.operation)) {
    problems.push(`operation ${r.operation} not allowed for discovery`);
  }
  if (r.company_claims.length || r.people.length || r.relationships.length) {
    problems.push('discovery results may only carry candidate companies');
  }
  const candidates: AdapterCompanyCandidate[] = [];
  for (const c of r.companies ?? []) {
    try {
      candidates.push({ ...c, domain: normalizeDomain(c.domain) });
    } catch {
      problems.push(`candidate ${c.ref}: domain not accepted`);
    }
  }
  if (problems.length) {
    return recordSourceFailure(db, {
      ...input,
      errorCode:
        r.operation === 'discover_companies'
          ? 'SOURCE_POLICY_VIOLATION'
          : 'ADAPTER_PAYLOAD_INVALID',
      errorSummary: problems.slice(0, 5).join('; '),
    });
  }
  if (r.status === 'failed') {
    return recordSourceFailure(db, {
      ...input,
      errorCode: r.error?.code ?? 'SOURCE_FAILED',
      errorSummary: r.error?.message ?? 'Source reported failure.',
    });
  }

  const observedAt = new Date();
  const counts = await withContext(db, ctx, async (trx) => {
    const evidenceIds = new Map<string, string>();
    for (const e of r.evidence) {
      const row = await trx
        .insertInto('evidence_records')
        .values({
          tenant_id: input.tenantId,
          company_id: null,
          source_registry_id: input.sourceKey,
          workflow_job_id: input.jobId,
          source_url: e.source_url,
          fetched_at: e.fetched_at,
          published_at: e.published_at,
          content_hash: e.content_hash,
          content_type: e.content_type,
          excerpt: e.excerpt,
          license_metadata: JSON.stringify(e.license_metadata),
          retention_until: new Date(observedAt.getTime() + source.retention_days * 86_400_000),
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'source_registry_id', 'source_url', 'content_hash'])
            .doUpdateSet({ workflow_job_id: input.jobId }),
        )
        .returning(['id', 'storage_key'])
        .executeTakeFirstOrThrow();
      if (!row.storage_key) {
        const key = discoveryEvidenceKey(input.tenantId, input.jobId, row.id);
        await storage.put(
          key,
          JSON.stringify({
            evidence_id: row.id,
            source_key: input.sourceKey,
            source_url: e.source_url,
            fetched_at: e.fetched_at,
            content_hash: e.content_hash,
            content_type: e.content_type,
            normalized_content: e.normalized_content,
          }),
          'application/json',
        );
        await trx
          .updateTable('evidence_records')
          .set({ storage_key: key })
          .where('id', '=', row.id)
          .execute();
      }
      evidenceIds.set(e.ref, row.id);
    }

    let inserted = 0;
    for (const c of candidates) {
      const evidenceId = evidenceIds.get(c.evidence_refs[0] as string) as string;
      const row = await trx
        .insertInto('discovery_candidates')
        .values({
          tenant_id: input.tenantId,
          job_id: input.jobId,
          source_key: input.sourceKey,
          domain: c.domain,
          name: c.name,
          country_code: c.country_code,
          description: c.description,
          claim_type: c.claim_type,
          confidence: c.confidence,
          evidence_record_id: evidenceId,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'job_id', 'domain']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (row) inserted += 1;
    }

    await trx
      .insertInto('provider_usage')
      .values({
        tenant_id: input.tenantId,
        workflow_job_id: input.jobId,
        provider: r.provider,
        source_key: input.sourceKey,
        operation: r.operation,
        request_count: r.usage.request_count,
        units: r.usage.units,
        unit_type: r.usage.unit_type,
        status: 'succeeded',
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'workflow_job_id', 'source_key', 'operation']).doNothing(),
      )
      .execute();
    await setSourceStatus(trx, input, 'succeeded', { evidenceCount: evidenceIds.size });
    await enqueueEvent(trx, {
      tenantId: input.tenantId,
      eventType: 'discovery.source.completed',
      correlationId: input.correlationId,
      idempotencyKey: `${input.jobId}:${input.sourceKey}`,
      payload: {
        job_id: input.jobId,
        source_key: input.sourceKey,
        status: 'succeeded',
        evidence_ids: [...evidenceIds.values()],
        candidates: inserted,
      },
    });
    await recordAudit(trx, {
      tenantId: input.tenantId,
      actorUserId: null,
      action: 'discovery.source.persisted',
      entityType: 'discovery_job',
      entityId: input.jobId,
      correlationId: input.correlationId,
      metadata: { source_key: input.sourceKey, evidence: evidenceIds.size, candidates: inserted },
    });
    return { evidence: evidenceIds.size };
  });
  return { sourceKey: input.sourceKey, status: 'succeeded', evidenceCount: counts.evidence };
}
