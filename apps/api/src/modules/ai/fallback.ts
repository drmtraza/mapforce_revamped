import type { OrgMapV2, PersonPredicate } from '@mapforce/contracts';
import { canonicalizeTitle, personaConfidence, personaFromTitle } from './taxonomy.ts';
import type { OrgMapRequest } from './types.ts';

const PERSON_PREDICATES = new Set<PersonPredicate>([
  'REPORTS_TO',
  'INFLUENCES',
  'DECIDES_FOR',
  'WORKS_WITH',
]);

/**
 * Deterministic non-LLM map: title taxonomy + already-sourced relationships.
 * Does not parse excerpts, so prompt-injection in page text cannot invent people.
 */
export function fallbackOrgMap(request: OrgMapRequest): OrgMapV2 {
  const people = request.people.map((p) => {
    const title = canonicalizeTitle(p.title);
    const persona = personaFromTitle(title);
    const signal = request.signals[0];
    const angleEvidence = (
      signal?.evidence_ids.length ? signal.evidence_ids : p.evidence_ids
    ).slice(0, 3);
    const outreach =
      angleEvidence.length > 0
        ? {
            value:
              signal?.signal_type === 'hiring'
                ? `Ask how ${p.display_name} is staffing the posted roles. Hiring is not evidence of approved budget.`
                : signal
                  ? `Reference the observed ${signal.signal_type} signal when asking whether it is relevant to ${p.display_name}.`
                  : `Ask ${p.display_name} about the published ${title ?? 'role'} and who else is involved. Do not treat this as buying intent.`,
            claim_type: 'model_inference' as const,
            confidence: 0.45,
            evidence_ids: angleEvidence,
            rationale: signal
              ? `Grounded in signal ${signal.id}; do not treat this as purchase intent.`
              : 'Grounded only in the cited role evidence; this is a draft for human review.',
          }
        : null;
    return {
      person_id: p.person_id,
      display_name: p.display_name,
      canonical_title: title,
      review_status: p.review_status as OrgMapV2['people'][number]['review_status'],
      persona,
      confidence: personaConfidence(persona, title),
      evidence_ids: p.evidence_ids.slice(0, 8),
      outreach_angle: outreach,
    };
  });

  const relationships = request.relationships
    .filter((r) => PERSON_PREDICATES.has(r.predicate as PersonPredicate) && r.evidence_ids.length)
    .map((r) => ({
      subject_person_id: r.subject_person_id,
      predicate: r.predicate as PersonPredicate,
      object_person_id: r.object_person_id,
      status: r.status as OrgMapV2['relationships'][number]['status'],
      claim_type: r.claim_type as OrgMapV2['relationships'][number]['claim_type'],
      confidence: 0.5,
      evidence_ids: r.evidence_ids,
      rationale: r.rationale,
    }));

  const classified = new Set(people.map((p) => p.persona));
  const unknowns: string[] = [];
  if (people.length === 0) unknowns.push('No candidate people discovered yet. Run a research job.');
  if (people.some((p) => p.persona === 'unknown')) {
    unknowns.push('Some titles could not be mapped to a buying-unit persona.');
  }
  if (!classified.has('economic_buyer')) {
    unknowns.push('No economic buyer classified from available titles.');
  }

  return {
    schema_version: 2,
    company_id: request.company.id,
    people,
    relationships,
    unknowns,
    conflicts: people
      .filter((p) => p.review_status === 'disputed')
      .map((p) => `Identity or role of ${p.display_name} is disputed.`),
  };
}
