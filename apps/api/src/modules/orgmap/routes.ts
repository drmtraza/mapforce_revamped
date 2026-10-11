import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { validateOrgMapV2, type OrgMapV2, type PersonPredicate } from '@mapforce/contracts';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { loadCompany } from '../companies/routes.ts';

const PERSON_PREDICATES: PersonPredicate[] = [
  'REPORTS_TO',
  'INFLUENCES',
  'DECIDES_FOR',
  'WORKS_WITH',
];

export const orgMapRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/companies/:id/org-map',
      {
        schema: {
          tags: ['org-map'],
          description: 'Organization map conforming to contracts/org-map.v2.schema.json.',
          params: z.object({ id: z.uuid() }),
          response: { 200: z.record(z.string(), z.unknown()) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.read');
        const map = await withContext(db, ctx, async (trx): Promise<OrgMapV2> => {
          const company = await loadCompany(trx, ctx.tenantId, request.params.id);
          const people = await trx
            .selectFrom('person_company_links as l')
            .innerJoin('people as p', 'p.id', 'l.person_id')
            .leftJoin('employment_roles as r', (j) =>
              j
                .onRef('r.person_id', '=', 'p.id')
                .onRef('r.company_id', '=', 'l.company_id')
                .on('r.status', '=', 'current'),
            )
            .select(['p.id', 'p.canonical_name', 'p.review_status', 'r.title', 'l.confidence'])
            .where('l.tenant_id', '=', ctx.tenantId)
            .where('l.company_id', '=', company.id)
            .where('p.review_status', '!=', 'rejected')
            .where('p.merged_into_id', 'is', null)
            .limit(500)
            .execute();
          const personIds = people.map((p) => p.id);
          if (personIds.length === 0) {
            return {
              schema_version: 2,
              company_id: company.id,
              people: [],
              relationships: [],
              unknowns: ['No candidate people discovered yet. Run a research job.'],
              conflicts: [],
            };
          }

          const personEvidence = await trx
            .selectFrom('claims as c')
            .innerJoin('claim_evidence as ce', 'ce.claim_id', 'c.id')
            .select(['c.subject_id', 'ce.evidence_record_id'])
            .where('c.tenant_id', '=', ctx.tenantId)
            .where('c.subject_type', '=', 'person')
            .where('c.subject_id', 'in', personIds)
            .execute();
          const evidenceByPerson = new Map<string, Set<string>>();
          for (const row of personEvidence) {
            const set = evidenceByPerson.get(row.subject_id) ?? new Set<string>();
            set.add(row.evidence_record_id);
            evidenceByPerson.set(row.subject_id, set);
          }

          const rels = await trx
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
            .where('tenant_id', '=', ctx.tenantId)
            .where('subject_type', '=', 'person')
            .where('object_type', '=', 'person')
            .where('predicate', 'in', PERSON_PREDICATES)
            .where('subject_id', 'in', personIds)
            .where('object_id', 'in', personIds)
            .execute();
          const relEvidence = rels.length
            ? await trx
                .selectFrom('relationship_evidence')
                .select(['relationship_id', 'evidence_record_id'])
                .where('tenant_id', '=', ctx.tenantId)
                .where(
                  'relationship_id',
                  'in',
                  rels.map((r) => r.id),
                )
                .execute()
            : [];
          const evidenceByRel = new Map<string, string[]>();
          for (const row of relEvidence) {
            evidenceByRel.set(row.relationship_id, [
              ...(evidenceByRel.get(row.relationship_id) ?? []),
              row.evidence_record_id,
            ]);
          }

          const disputed = people.filter((p) => p.review_status === 'disputed');
          return {
            schema_version: 2,
            company_id: company.id,
            people: people.map((p) => ({
              person_id: p.id,
              display_name: p.canonical_name,
              canonical_title: p.title,
              review_status: p.review_status,
              persona: 'unknown',
              confidence: Number(p.confidence),
              evidence_ids: [...(evidenceByPerson.get(p.id) ?? [])],
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
            unknowns: [
              'Buying-unit personas are not classified yet (AI organization mapping is Phase 4).',
            ],
            conflicts: disputed.map((p) => `Identity or role of ${p.canonical_name} is disputed.`),
          };
        });

        const check = validateOrgMapV2(map);
        if (!check.ok) {
          request.log.error({ errors: check.errors }, 'org map failed contract validation');
          throw new AppError('INTERNAL_ERROR', 'Organization map could not be produced.');
        }
        return map as unknown as Record<string, unknown>;
      },
    );
  };
