import type { OrgMapV2, Persona, PersonPredicate } from '@mapforce/contracts';
import type { Tx } from '@mapforce/db';
import { loadCompany } from '../companies/routes.ts';
import type {
  CompactEvidence,
  CompactIcp,
  CompactPerson,
  CompactRelationship,
  CompactSignal,
  OrgMapRequest,
} from './types.ts';

const PERSON_PREDICATES: PersonPredicate[] = [
  'REPORTS_TO',
  'INFLUENCES',
  'DECIDES_FOR',
  'WORKS_WITH',
];

export interface SourcedGraph {
  request: OrgMapRequest;
  sourced: OrgMapV2;
}

export async function gatherOrgMapRequest(
  trx: Tx,
  tenantId: string,
  companyId: string,
): Promise<SourcedGraph> {
  const company = await loadCompany(trx, tenantId, companyId);
  const peopleRows = await trx
    .selectFrom('person_company_links as l')
    .innerJoin('people as p', 'p.id', 'l.person_id')
    .leftJoin('employment_roles as r', (j) =>
      j
        .onRef('r.person_id', '=', 'p.id')
        .onRef('r.company_id', '=', 'l.company_id')
        .on('r.status', '=', 'current'),
    )
    .select(['p.id', 'p.canonical_name', 'p.review_status', 'r.title', 'l.confidence'])
    .where('l.tenant_id', '=', tenantId)
    .where('l.company_id', '=', company.id)
    .where('p.review_status', '!=', 'rejected')
    .where('p.merged_into_id', 'is', null)
    .limit(500)
    .execute();
  const personIds = peopleRows.map((p) => p.id);

  const personEvidence = personIds.length
    ? await trx
        .selectFrom('claims as c')
        .innerJoin('claim_evidence as ce', 'ce.claim_id', 'c.id')
        .select(['c.subject_id', 'ce.evidence_record_id'])
        .where('c.tenant_id', '=', tenantId)
        .where('c.subject_type', '=', 'person')
        .where('c.subject_id', 'in', personIds)
        .limit(2000)
        .execute()
    : [];
  const evidenceByPerson = new Map<string, Set<string>>();
  for (const row of personEvidence) {
    const set = evidenceByPerson.get(row.subject_id) ?? new Set<string>();
    set.add(row.evidence_record_id);
    evidenceByPerson.set(row.subject_id, set);
  }

  const rels = personIds.length
    ? await trx
        .selectFrom('relationships')
        .select([
          'id',
          'subject_id',
          'predicate',
          'object_id',
          'status',
          'claim_type',
          'confidence',
          'rationale',
        ])
        .where('tenant_id', '=', tenantId)
        .where('subject_type', '=', 'person')
        .where('object_type', '=', 'person')
        .where('predicate', 'in', PERSON_PREDICATES)
        .where('subject_id', 'in', personIds)
        .where('object_id', 'in', personIds)
        .limit(500)
        .execute()
    : [];
  const relEvidence = rels.length
    ? await trx
        .selectFrom('relationship_evidence')
        .select(['relationship_id', 'evidence_record_id'])
        .where('tenant_id', '=', tenantId)
        .where(
          'relationship_id',
          'in',
          rels.map((r) => r.id),
        )
        .limit(2000)
        .execute()
    : [];
  const evidenceByRel = new Map<string, string[]>();
  for (const row of relEvidence) {
    evidenceByRel.set(row.relationship_id, [
      ...(evidenceByRel.get(row.relationship_id) ?? []),
      row.evidence_record_id,
    ]);
  }

  const compactPeople: CompactPerson[] = peopleRows.map((p) => ({
    person_id: p.id,
    display_name: p.canonical_name,
    title: p.title,
    review_status: p.review_status,
    evidence_ids: [...(evidenceByPerson.get(p.id) ?? [])],
  }));
  const compactRels: CompactRelationship[] = rels
    .filter((r) => (evidenceByRel.get(r.id)?.length ?? 0) > 0)
    .map((r) => ({
      subject_person_id: r.subject_id,
      object_person_id: r.object_id,
      predicate: r.predicate,
      status: r.status,
      claim_type: r.claim_type,
      rationale: r.rationale,
      evidence_ids: evidenceByRel.get(r.id) ?? [],
    }));

  const signals = await trx
    .selectFrom('intent_signals')
    .select(['id', 'signal_type', 'title', 'summary', 'implies_budget'])
    .where('tenant_id', '=', tenantId)
    .where('company_id', '=', company.id)
    .orderBy('observed_at', 'desc')
    .limit(50)
    .execute();
  const signalEvidence = signals.length
    ? await trx
        .selectFrom('signal_evidence')
        .select(['signal_id', 'evidence_record_id'])
        .where('tenant_id', '=', tenantId)
        .where(
          'signal_id',
          'in',
          signals.map((s) => s.id),
        )
        .execute()
    : [];
  const evidenceBySignal = new Map<string, string[]>();
  for (const row of signalEvidence) {
    evidenceBySignal.set(row.signal_id, [
      ...(evidenceBySignal.get(row.signal_id) ?? []),
      row.evidence_record_id,
    ]);
  }
  const compactSignals: CompactSignal[] = signals.map((s) => ({
    id: s.id,
    signal_type: s.signal_type,
    title: s.title,
    summary: s.summary,
    implies_budget: s.implies_budget,
    evidence_ids: evidenceBySignal.get(s.id) ?? [],
  }));

  const evidenceIds = [
    ...new Set([
      ...compactPeople.flatMap((p) => p.evidence_ids),
      ...compactRels.flatMap((r) => r.evidence_ids),
      ...compactSignals.flatMap((s) => s.evidence_ids),
    ]),
  ];
  const evidenceRows = evidenceIds.length
    ? await trx
        .selectFrom('evidence_records')
        .select(['id', 'source_registry_id', 'source_url', 'fetched_at', 'excerpt'])
        .where('tenant_id', '=', tenantId)
        .where('id', 'in', evidenceIds)
        .execute()
    : [];
  const evidence: CompactEvidence[] = evidenceRows.map((e) => ({
    id: e.id,
    source_key: e.source_registry_id,
    source_url: e.source_url,
    fetched_at: e.fetched_at.toISOString(),
    excerpt: (e.excerpt ?? '').slice(0, 800),
  }));

  const icpRow = await trx
    .selectFrom('icp_profiles')
    .select(['name', 'definition'])
    .where('tenant_id', '=', tenantId)
    .where('active', '=', true)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const def = (icpRow?.definition ?? {}) as {
    industries?: string[];
    countries?: string[];
    target_personas?: Persona[];
    signals?: string[];
  };
  const icp: CompactIcp | null = icpRow
    ? {
        name: icpRow.name,
        industries: def.industries ?? [],
        countries: def.countries ?? [],
        target_personas: def.target_personas ?? [],
        signals: def.signals ?? [],
      }
    : null;

  const sourced: OrgMapV2 = {
    schema_version: 2,
    company_id: company.id,
    people: compactPeople.map((p, i) => ({
      person_id: p.person_id,
      display_name: p.display_name,
      canonical_title: p.title,
      review_status: p.review_status as OrgMapV2['people'][number]['review_status'],
      persona: 'unknown',
      confidence: Number(peopleRows[i]!.confidence),
      evidence_ids: p.evidence_ids,
      outreach_angle: null,
    })),
    relationships: rels
      .filter((r) => (evidenceByRel.get(r.id)?.length ?? 0) > 0)
      .map((r) => ({
        relationship_id: r.id,
        subject_person_id: r.subject_id,
        predicate: r.predicate as PersonPredicate,
        object_person_id: r.object_id,
        status: r.status,
        claim_type: r.claim_type,
        confidence: Number(r.confidence),
        evidence_ids: evidenceByRel.get(r.id) ?? [],
        rationale: r.rationale,
      })),
    unknowns:
      personIds.length === 0
        ? ['No candidate people discovered yet. Run a research job.']
        : ['Buying-unit personas are not classified yet (AI organization mapping is Phase 4).'],
    conflicts: peopleRows
      .filter((p) => p.review_status === 'disputed')
      .map((p) => `Identity or role of ${p.canonical_name} is disputed.`),
  };

  return {
    sourced,
    request: {
      company: { id: company.id, name: company.canonical_name, domain: company.primary_domain },
      people: compactPeople,
      relationships: compactRels,
      signals: compactSignals,
      evidence,
      icp,
    },
  };
}

export function applyOverlay(sourced: OrgMapV2, overlay: OrgMapV2): OrgMapV2 {
  const byId = new Map(overlay.people.map((p) => [p.person_id, p]));
  const sourcedKeys = new Set(
    sourced.relationships.map((r) => `${r.subject_person_id}|${r.predicate}|${r.object_person_id}`),
  );
  const extra = overlay.relationships.filter(
    (r) => !sourcedKeys.has(`${r.subject_person_id}|${r.predicate}|${r.object_person_id}`),
  );
  return {
    schema_version: 2,
    company_id: sourced.company_id,
    people: sourced.people.map((p) => {
      const o = byId.get(p.person_id);
      if (!o) return p;
      return {
        ...p,
        persona: o.persona,
        confidence: o.confidence,
        canonical_title: o.canonical_title ?? p.canonical_title,
        outreach_angle: o.outreach_angle ?? null,
      };
    }),
    relationships: [...sourced.relationships, ...extra],
    unknowns: overlay.unknowns,
    conflicts: [...new Set([...sourced.conflicts, ...overlay.conflicts])],
  };
}
