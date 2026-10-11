import { isIP } from 'node:net';
import { validateAdapterResult, type AdapterResult } from '@mapforce/contracts';
import { withContext, type Db, type SourceStatus, type Tx } from '@mapforce/db';
import { hostWithinDomain } from '../../domain.ts';
import { recordAudit } from '../audit/service.ts';
import { evidenceKey, type EvidenceStorage } from '../evidence/storage.ts';
import { enqueueEvent } from '../outbox/service.ts';
import type { SourceOutcome } from '../../temporal/types.ts';

export interface PersistInput {
  tenantId: string;
  jobId: string;
  companyId: string;
  sourceKey: string;
  correlationId: string;
  attempts: number;
  result: unknown;
}

export interface FailureInput {
  tenantId: string;
  jobId: string;
  sourceKey: string;
  correlationId: string;
  attempts: number;
  errorCode: string;
  errorSummary: string;
}

const DOMAIN_BOUND_SOURCE_TYPES = new Set(['company_website']);

export function normalizePersonName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Rejects evidence URLs that are not public http(s) resources, and for domain-bound
 * sources (company websites) URLs that leave the target domain.
 */
export function checkUrlPolicy(
  r: AdapterResult,
  sourceType: string,
  domain: string | null,
): string[] {
  const errors: string[] = [];
  for (const e of r.evidence) {
    let url: URL;
    try {
      url = new URL(e.source_url);
    } catch {
      errors.push(`evidence ${e.ref}: unparsable URL`);
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push(`evidence ${e.ref}: non-http URL`);
    }
    if (url.username || url.password) errors.push(`evidence ${e.ref}: URL contains credentials`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) || host === 'localhost' || !host.includes('.')) {
      errors.push(`evidence ${e.ref}: non-public host`);
    }
    if (
      DOMAIN_BOUND_SOURCE_TYPES.has(sourceType) &&
      (domain === null || !hostWithinDomain(host, domain))
    ) {
      errors.push(`evidence ${e.ref}: host outside target domain`);
    }
  }
  return errors;
}

export async function setSourceStatus(
  trx: Tx,
  input: { tenantId: string; jobId: string; sourceKey: string; attempts: number },
  status: SourceStatus,
  extra: { evidenceCount?: number; errorCode?: string | null; errorSummary?: string | null } = {},
) {
  await trx
    .updateTable('workflow_job_sources')
    .set({
      status,
      attempts: input.attempts,
      evidence_count: extra.evidenceCount ?? 0,
      error_code: extra.errorCode ?? null,
      error_summary: extra.errorSummary?.slice(0, 500) ?? null,
      finished_at: new Date(),
    })
    .where('tenant_id', '=', input.tenantId)
    .where('job_id', '=', input.jobId)
    .where('source_key', '=', input.sourceKey)
    .execute();
}

export async function recordSourceFailure(db: Db, input: FailureInput): Promise<SourceOutcome> {
  await withContext(db, { tenantId: input.tenantId, userId: null }, async (trx) => {
    await setSourceStatus(trx, input, 'failed', {
      errorCode: input.errorCode,
      errorSummary: input.errorSummary,
    });
    await recordAudit(trx, {
      tenantId: input.tenantId,
      actorUserId: null,
      action: 'research.source.failed',
      entityType: 'research_job',
      entityId: input.jobId,
      outcome: 'failure',
      correlationId: input.correlationId,
      metadata: { source_key: input.sourceKey, error_code: input.errorCode },
    });
    await enqueueEvent(trx, {
      tenantId: input.tenantId,
      eventType: 'discovery.source.completed',
      correlationId: input.correlationId,
      idempotencyKey: `${input.jobId}:${input.sourceKey}`,
      payload: { job_id: input.jobId, source_key: input.sourceKey, status: 'failed' },
    });
  });
  return { sourceKey: input.sourceKey, status: 'failed', errorCode: input.errorCode };
}

/**
 * Validates an adapter payload and, only if valid, writes evidence, claims, people,
 * roles and relationships atomically with usage, outbox and audit records.
 * Safe to retry: every write is idempotent on natural keys.
 */
export async function persistSourceResult(
  db: Db,
  storage: EvidenceStorage,
  input: PersistInput,
): Promise<SourceOutcome> {
  const ctx = { tenantId: input.tenantId, userId: null };
  const loaded = await withContext(db, ctx, async (trx) => {
    const job = await trx
      .selectFrom('workflow_jobs as j')
      .innerJoin('companies as c', 'c.id', 'j.company_id')
      .select(['j.id', 'j.status', 'j.company_id', 'c.primary_domain', 'c.canonical_name'])
      .where('j.tenant_id', '=', input.tenantId)
      .where('j.id', '=', input.jobId)
      .executeTakeFirst();
    const source = await trx
      .selectFrom('source_registry')
      .select(['id', 'source_type', 'enabled', 'retention_days', 'provider_name', 'operations'])
      .where('id', '=', input.sourceKey)
      .executeTakeFirst();
    return { job, source };
  });
  const { job, source } = loaded;
  if (!job || job.company_id !== input.companyId) {
    throw new Error('Job not found for tenant or company mismatch');
  }
  if (job.status === 'cancelled') return { sourceKey: input.sourceKey, status: 'cancelled' };
  if (!source?.enabled) {
    return recordSourceFailure(db, {
      ...input,
      errorCode: 'SOURCE_DISABLED',
      errorSummary: 'Source is not registered or is disabled.',
    });
  }

  const validation = validateAdapterResult(input.result);
  const policyErrors = validation.ok
    ? checkUrlPolicy(validation.value, source.source_type, job.primary_domain)
    : [];
  if (!validation.ok || policyErrors.length) {
    const errors = validation.ok ? policyErrors : validation.errors;
    return recordSourceFailure(db, {
      ...input,
      errorCode: validation.ok ? 'SOURCE_POLICY_VIOLATION' : 'ADAPTER_PAYLOAD_INVALID',
      errorSummary: errors.slice(0, 5).join('; '),
    });
  }
  const r = validation.value;
  if (r.source_key !== input.sourceKey) {
    return recordSourceFailure(db, {
      ...input,
      errorCode: 'ADAPTER_PAYLOAD_INVALID',
      errorSummary: 'source_key does not match the requested source.',
    });
  }
  if (r.operation === 'discover_companies' || !source.operations.includes(r.operation)) {
    return recordSourceFailure(db, {
      ...input,
      errorCode: 'ADAPTER_PAYLOAD_INVALID',
      errorSummary: `Operation ${r.operation} is not allowed for this source in a research job.`,
    });
  }
  if (r.status === 'failed') {
    return recordSourceFailure(db, {
      ...input,
      errorCode: r.error?.code ?? 'SOURCE_FAILED',
      errorSummary: r.error?.message ?? 'Source reported failure.',
    });
  }

  const retentionDays = source.retention_days;
  const observedAt = new Date();

  const counts = await withContext(db, ctx, async (trx) => {
    const evidenceIds = new Map<string, string>();
    for (const e of r.evidence) {
      const row = await trx
        .insertInto('evidence_records')
        .values({
          tenant_id: input.tenantId,
          company_id: input.companyId,
          source_registry_id: input.sourceKey,
          workflow_job_id: input.jobId,
          source_url: e.source_url,
          fetched_at: e.fetched_at,
          published_at: e.published_at,
          content_hash: e.content_hash,
          content_type: e.content_type,
          excerpt: e.excerpt,
          license_metadata: JSON.stringify(e.license_metadata),
          retention_until: new Date(observedAt.getTime() + retentionDays * 86_400_000),
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'source_registry_id', 'source_url', 'content_hash'])
            .doUpdateSet({ workflow_job_id: input.jobId }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      const key = evidenceKey(input.tenantId, input.companyId, row.id);
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
      evidenceIds.set(e.ref, row.id);
    }
    const ev = (refs: string[]) => refs.map((ref) => evidenceIds.get(ref) as string);

    const upsertClaim = async (c: {
      subjectType: 'company' | 'person' | 'employment_role';
      subjectId: string;
      predicate: string;
      value: unknown;
      claimType: 'source_fact' | 'provider_fact' | 'model_inference';
      confidence: number;
      rationale?: string | null;
      evidence: string[];
    }) => {
      const claim = await trx
        .insertInto('claims')
        .values({
          tenant_id: input.tenantId,
          subject_type: c.subjectType,
          subject_id: c.subjectId,
          predicate: c.predicate,
          object_value: JSON.stringify(c.value),
          claim_type: c.claimType,
          confidence: c.confidence,
          rationale: c.rationale ?? null,
          source_key: input.sourceKey,
          workflow_job_id: input.jobId,
          observed_at: observedAt,
        })
        .onConflict((oc) =>
          oc
            .columns([
              'tenant_id',
              'subject_type',
              'subject_id',
              'predicate',
              'source_key',
              'object_value',
            ])
            .doUpdateSet({ observed_at: observedAt, confidence: c.confidence }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('claim_evidence')
        .values(
          c.evidence.map((evidenceId) => ({
            claim_id: claim.id,
            evidence_record_id: evidenceId,
            tenant_id: input.tenantId,
          })),
        )
        .onConflict((oc) => oc.columns(['claim_id', 'evidence_record_id']).doNothing())
        .execute();
    };

    // Company claims are retained as claims; canonical fields are only filled when empty.
    const fill: Record<string, string> = {};
    for (const c of r.company_claims) {
      await upsertClaim({
        subjectType: 'company',
        subjectId: input.companyId,
        predicate: c.predicate,
        value: c.value,
        claimType: c.claim_type,
        confidence: c.confidence,
        evidence: ev(c.evidence_refs),
      });
      if (c.predicate === 'alias') {
        await trx
          .insertInto('company_aliases')
          .values({
            tenant_id: input.tenantId,
            company_id: input.companyId,
            alias: c.value,
            source_evidence_id: ev(c.evidence_refs)[0] ?? null,
          })
          .onConflict((oc) => oc.columns(['tenant_id', 'company_id', 'alias']).doNothing())
          .execute();
      } else if (c.predicate === 'registry_identifier') {
        await trx
          .insertInto('company_identifiers')
          .values({
            tenant_id: input.tenantId,
            company_id: input.companyId,
            identifier_type: 'registry_number',
            identifier_value: c.value,
            source_evidence_id: ev(c.evidence_refs)[0] ?? null,
          })
          .onConflict((oc) =>
            oc
              .columns(['tenant_id', 'company_id', 'identifier_type', 'identifier_value'])
              .doNothing(),
          )
          .execute();
      } else {
        fill[c.predicate] ??= c.value;
      }
    }
    if (Object.keys(fill).length) {
      const current = await trx
        .selectFrom('companies')
        .select([
          'canonical_name',
          'primary_domain',
          'description',
          'industry',
          'country_code',
          'employee_band',
        ])
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.companyId)
        .executeTakeFirstOrThrow();
      const patch: Record<string, string> = {};
      if (fill.canonical_name && current.canonical_name === current.primary_domain) {
        patch.canonical_name = fill.canonical_name;
      }
      for (const field of ['description', 'industry', 'country_code', 'employee_band'] as const) {
        const value = fill[field];
        if (value && current[field] === null) patch[field] = value;
      }
      if (Object.keys(patch).length) {
        await trx
          .updateTable('companies')
          .set((eb) => ({ ...patch, version: eb('version', '+', 1) }))
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.companyId)
          .execute();
      }
    }

    // People are matched on normalized name within this company only; never on name alone.
    const personIds = new Map<string, string>();
    for (const p of r.people) {
      const normalized = normalizePersonName(p.full_name);
      const existing = await trx
        .selectFrom('people as pe')
        .innerJoin('person_company_links as l', 'l.person_id', 'pe.id')
        .select('pe.id')
        .where('pe.tenant_id', '=', input.tenantId)
        .where('l.company_id', '=', input.companyId)
        .where('pe.normalized_name', '=', normalized)
        .executeTakeFirst();
      const personId =
        existing?.id ??
        (
          await trx
            .insertInto('people')
            .values({
              tenant_id: input.tenantId,
              canonical_name: p.full_name,
              normalized_name: normalized,
              public_profile_url: p.public_profile_url,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      personIds.set(p.ref, personId);

      await trx
        .insertInto('person_company_links')
        .values({
          tenant_id: input.tenantId,
          person_id: personId,
          company_id: input.companyId,
          relationship_status: 'current',
          confidence: p.confidence,
          valid_from: observedAt,
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'person_id', 'company_id'])
            .doUpdateSet({ confidence: p.confidence }),
        )
        .execute();
      const role = await trx
        .insertInto('employment_roles')
        .values({
          tenant_id: input.tenantId,
          person_id: personId,
          company_id: input.companyId,
          title: p.title,
          department: p.department,
          seniority: p.seniority,
          status: 'current',
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'person_id', 'company_id', 'title'])
            .doUpdateSet({ department: p.department, seniority: p.seniority }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();

      const evidence = ev(p.evidence_refs);
      await upsertClaim({
        subjectType: 'person',
        subjectId: personId,
        predicate: 'full_name',
        value: p.full_name,
        claimType: p.claim_type,
        confidence: p.confidence,
        evidence,
      });
      if (p.title) {
        await upsertClaim({
          subjectType: 'employment_role',
          subjectId: role.id,
          predicate: 'title',
          value: p.title,
          claimType: p.claim_type,
          confidence: p.confidence,
          evidence,
        });
      }
      const worksAt = await trx
        .insertInto('relationships')
        .values({
          tenant_id: input.tenantId,
          subject_type: 'person',
          subject_id: personId,
          predicate: 'WORKS_AT',
          object_type: 'company',
          object_id: input.companyId,
          status: 'verified',
          claim_type: p.claim_type,
          confidence: p.confidence,
          rationale: `Listed as current at ${job.primary_domain} by ${source.provider_name}.`,
          source_key: input.sourceKey,
          workflow_job_id: input.jobId,
          valid_from: observedAt,
        })
        .onConflict((oc) =>
          oc
            .columns([
              'tenant_id',
              'subject_type',
              'subject_id',
              'predicate',
              'object_type',
              'object_id',
            ])
            .doUpdateSet({ confidence: p.confidence }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('relationship_evidence')
        .values(
          evidence.map((id) => ({
            relationship_id: worksAt.id,
            evidence_record_id: id,
            tenant_id: input.tenantId,
          })),
        )
        .onConflict((oc) => oc.columns(['relationship_id', 'evidence_record_id']).doNothing())
        .execute();
    }

    for (const rel of r.relationships) {
      const subjectId = personIds.get(rel.subject_ref) as string;
      const objectId = personIds.get(rel.object_ref) as string;
      const row = await trx
        .insertInto('relationships')
        .values({
          tenant_id: input.tenantId,
          subject_type: 'person',
          subject_id: subjectId,
          predicate: rel.predicate,
          object_type: 'person',
          object_id: objectId,
          status: rel.status,
          claim_type: rel.claim_type,
          confidence: rel.confidence,
          rationale: rel.rationale,
          source_key: input.sourceKey,
          workflow_job_id: input.jobId,
          valid_from: observedAt,
        })
        .onConflict((oc) =>
          oc
            .columns([
              'tenant_id',
              'subject_type',
              'subject_id',
              'predicate',
              'object_type',
              'object_id',
            ])
            .doUpdateSet({ confidence: rel.confidence, rationale: rel.rationale }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('relationship_evidence')
        .values(
          ev(rel.evidence_refs).map((id) => ({
            relationship_id: row.id,
            evidence_record_id: id,
            tenant_id: input.tenantId,
          })),
        )
        .onConflict((oc) => oc.columns(['relationship_id', 'evidence_record_id']).doNothing())
        .execute();
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

    await setSourceStatus(trx, input, 'succeeded', { evidenceCount: r.evidence.length });
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
      },
    });
    if (personIds.size) {
      await enqueueEvent(trx, {
        tenantId: input.tenantId,
        eventType: 'person.candidate.discovered',
        correlationId: input.correlationId,
        idempotencyKey: `${input.jobId}:${input.sourceKey}`,
        payload: {
          job_id: input.jobId,
          company_id: input.companyId,
          person_ids: [...personIds.values()],
        },
      });
    }
    await recordAudit(trx, {
      tenantId: input.tenantId,
      actorUserId: null,
      action: 'research.source.persisted',
      entityType: 'research_job',
      entityId: input.jobId,
      correlationId: input.correlationId,
      metadata: {
        source_key: input.sourceKey,
        evidence: evidenceIds.size,
        people: personIds.size,
        relationships: r.relationships.length,
      },
    });
    return { evidence: evidenceIds.size };
  });

  return { sourceKey: input.sourceKey, status: 'succeeded', evidenceCount: counts.evidence };
}
