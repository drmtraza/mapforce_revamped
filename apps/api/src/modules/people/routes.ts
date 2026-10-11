import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext, type Tx } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { loadCompany } from '../companies/routes.ts';
import { confidenceBand } from './confidence.ts';
import { acceptMatch, splitMerge } from './merge.ts';

const Confidence = z.object({
  value: z.number(),
  band: z.enum(['strong', 'plausible', 'weak', 'very_weak']),
  explanation: z.string(),
});

const PersonSummary = z.object({
  id: z.string(),
  canonical_name: z.string(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  seniority: z.string().nullable(),
  review_status: z.string(),
  confidence: Confidence,
  evidence_count: z.number(),
});

const EvidenceRef = z.object({
  id: z.string(),
  source_key: z.string(),
  provider_name: z.string(),
  is_mock: z.boolean(),
  source_url: z.string(),
  fetched_at: z.string(),
  content_hash: z.string(),
  excerpt: z.string().nullable(),
});

const Claim = z.object({
  id: z.string(),
  subject_type: z.string(),
  predicate: z.string(),
  value: z.unknown(),
  claim_type: z.enum(['source_fact', 'provider_fact', 'model_inference', 'user_assertion']),
  status: z.string(),
  confidence: Confidence,
  rationale: z.string().nullable(),
  observed_at: z.string(),
  evidence: z.array(EvidenceRef),
});

const PersonDetail = z.object({
  id: z.string(),
  canonical_name: z.string(),
  public_profile_url: z.string().nullable(),
  review_status: z.string(),
  version: z.number(),
  roles: z.array(
    z.object({
      id: z.string(),
      company_id: z.string(),
      title: z.string().nullable(),
      department: z.string().nullable(),
      seniority: z.string().nullable(),
      status: z.string(),
      start_date: z.string().nullable(),
      end_date: z.string().nullable(),
    }),
  ),
  aliases: z.array(z.string()),
  claims: z.array(Claim),
  contact_points: z.array(
    z.object({
      id: z.string(),
      contact_type: z.string(),
      display_hint: z.string(),
      status: z.string(),
      verification_method: z.string(),
      verified_at: z.string().nullable(),
      claim_type: z.string(),
      confidence: Confidence,
      source_key: z.string().nullable(),
    }),
  ),
  contact_points_note: z.string(),
  match_candidates: z.array(
    z.object({
      id: z.string(),
      other_person_id: z.string(),
      other_name: z.string(),
      score: z.number(),
      rationale: z.string(),
      status: z.string(),
    }),
  ),
  merges: z.array(
    z.object({
      id: z.string(),
      survivor_id: z.string(),
      absorbed_id: z.string(),
      undone_at: z.string().nullable(),
    }),
  ),
  reviews: z.array(
    z.object({
      decision: z.string(),
      reason: z.string().nullable(),
      actor_user_id: z.string(),
      created_at: z.string(),
    }),
  ),
});

const conf = (v: string | number) => {
  const value = Number(v);
  return { value, ...confidenceBand(value) };
};

async function evidenceForClaims(trx: Tx, tenantId: string, claimIds: string[]) {
  if (claimIds.length === 0) return new Map<string, z.infer<typeof EvidenceRef>[]>();
  const rows = await trx
    .selectFrom('claim_evidence as ce')
    .innerJoin('evidence_records as e', 'e.id', 'ce.evidence_record_id')
    .innerJoin('source_registry as s', 's.id', 'e.source_registry_id')
    .select([
      'ce.claim_id',
      'e.id',
      'e.source_registry_id as source_key',
      's.provider_name',
      's.is_mock',
      'e.source_url',
      'e.fetched_at',
      'e.content_hash',
      'e.excerpt',
    ])
    .where('ce.tenant_id', '=', tenantId)
    .where('ce.claim_id', 'in', claimIds)
    .execute();
  const map = new Map<string, z.infer<typeof EvidenceRef>[]>();
  for (const { claim_id, fetched_at, ...e } of rows) {
    const list = map.get(claim_id) ?? [];
    list.push({ ...e, fetched_at: fetched_at.toISOString() });
    map.set(claim_id, list);
  }
  return map;
}

export const peopleRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get(
      '/companies/:id/people',
      {
        schema: {
          tags: ['people'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ data: z.array(PersonSummary) }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.read');
        const rows = await withContext(db, ctx, async (trx) => {
          await loadCompany(trx, ctx.tenantId, request.params.id);
          return trx
            .selectFrom('person_company_links as l')
            .innerJoin('people as p', 'p.id', 'l.person_id')
            .leftJoin('employment_roles as r', (j) =>
              j
                .onRef('r.person_id', '=', 'p.id')
                .onRef('r.company_id', '=', 'l.company_id')
                .on('r.status', '=', 'current'),
            )
            .select((eb) => [
              'p.id',
              'p.canonical_name',
              'r.title',
              'r.department',
              'r.seniority',
              'p.review_status',
              'l.confidence',
              eb
                .selectFrom('claims as c')
                .innerJoin('claim_evidence as ce', 'ce.claim_id', 'c.id')
                .select((e2) => e2.fn.count<string>('ce.evidence_record_id').distinct().as('n'))
                .where('c.tenant_id', '=', ctx.tenantId)
                .whereRef('c.subject_id', '=', 'p.id')
                .as('evidence_count'),
            ])
            .where('l.tenant_id', '=', ctx.tenantId)
            .where('l.company_id', '=', request.params.id)
            .where('p.merged_into_id', 'is', null)
            .orderBy('p.canonical_name')
            .limit(500)
            .execute();
        });
        return {
          data: rows.map((r) => ({
            id: r.id,
            canonical_name: r.canonical_name,
            title: r.title,
            department: r.department,
            seniority: r.seniority,
            review_status: r.review_status,
            confidence: conf(r.confidence),
            evidence_count: Number(r.evidence_count ?? 0),
          })),
        };
      },
    );

    app.get(
      '/people/:id',
      {
        schema: {
          tags: ['people'],
          params: z.object({ id: z.uuid() }),
          response: { 200: PersonDetail },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.read');
        return withContext(db, ctx, async (trx) => {
          const person = await trx
            .selectFrom('people')
            .select([
              'id',
              'canonical_name',
              'public_profile_url',
              'review_status',
              'version',
              'merged_into_id',
            ])
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!person || person.merged_into_id) throw notFound('Person');

          const absorbed = await trx
            .selectFrom('people')
            .select('id')
            .where('tenant_id', '=', ctx.tenantId)
            .where('merged_into_id', '=', person.id)
            .execute();
          const personIds = [person.id, ...absorbed.map((a) => a.id)];

          const roles = await trx
            .selectFrom('employment_roles')
            .select([
              'id',
              'company_id',
              'title',
              'department',
              'seniority',
              'status',
              'start_date',
              'end_date',
            ])
            .where('tenant_id', '=', ctx.tenantId)
            .where('person_id', 'in', personIds)
            .orderBy('status')
            .limit(100)
            .execute();
          const aliases = await trx
            .selectFrom('person_aliases')
            .select('alias')
            .where('tenant_id', '=', ctx.tenantId)
            .where('person_id', '=', person.id)
            .limit(50)
            .execute();
          const contacts = await trx
            .selectFrom('contact_points')
            .select([
              'id',
              'contact_type',
              'display_hint',
              'status',
              'verification_method',
              'verified_at',
              'claim_type',
              'confidence',
              'source_key',
            ])
            .where('tenant_id', '=', ctx.tenantId)
            .where('person_id', 'in', personIds)
            .orderBy('created_at', 'desc')
            .limit(200)
            .execute();
          const rawMatches = await trx
            .selectFrom('match_candidates')
            .select(['id', 'person_a_id', 'person_b_id', 'score', 'rationale', 'status'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('status', '=', 'proposed')
            .where((eb) =>
              eb.or([eb('person_a_id', '=', person.id), eb('person_b_id', '=', person.id)]),
            )
            .limit(50)
            .execute();
          const otherIds = rawMatches.map((m) =>
            m.person_a_id === person.id ? m.person_b_id : m.person_a_id,
          );
          const otherPeople = otherIds.length
            ? await trx
                .selectFrom('people')
                .select(['id', 'canonical_name'])
                .where('tenant_id', '=', ctx.tenantId)
                .where('id', 'in', otherIds)
                .execute()
            : [];
          const otherName = new Map(otherPeople.map((p) => [p.id, p.canonical_name]));
          const matches = rawMatches.map((m) => {
            const otherId = m.person_a_id === person.id ? m.person_b_id : m.person_a_id;
            return {
              id: m.id,
              other_person_id: otherId,
              other_name: otherName.get(otherId) ?? 'Unknown',
              score: m.score,
              rationale: m.rationale,
              status: m.status,
            };
          });
          const merges = await trx
            .selectFrom('person_merges')
            .select(['id', 'survivor_id', 'absorbed_id', 'undone_at'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('survivor_id', '=', person.id)
            .where('undone_at', 'is', null)
            .limit(50)
            .execute();
          const subjectIds = [person.id, ...roles.map((r) => r.id)];
          const claims = await trx
            .selectFrom('claims')
            .select([
              'id',
              'subject_type',
              'predicate',
              'object_value',
              'claim_type',
              'status',
              'confidence',
              'rationale',
              'observed_at',
            ])
            .where('tenant_id', '=', ctx.tenantId)
            .where('subject_id', 'in', subjectIds)
            .orderBy('observed_at', 'desc')
            .limit(200)
            .execute();
          const evidence = await evidenceForClaims(
            trx,
            ctx.tenantId,
            claims.map((c) => c.id),
          );
          const reviews = await trx
            .selectFrom('person_reviews')
            .select(['decision', 'reason', 'actor_user_id', 'created_at'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('person_id', '=', person.id)
            .orderBy('created_at', 'desc')
            .limit(50)
            .execute();

          return {
            id: person.id,
            canonical_name: person.canonical_name,
            public_profile_url: person.public_profile_url,
            review_status: person.review_status,
            version: person.version,
            roles: roles.map((r) => ({
              ...r,
              start_date: r.start_date ? String(r.start_date).slice(0, 10) : null,
              end_date: r.end_date ? String(r.end_date).slice(0, 10) : null,
            })),
            claims: claims.map((c) => ({
              id: c.id,
              subject_type: c.subject_type,
              predicate: c.predicate,
              value: c.object_value,
              claim_type: c.claim_type,
              status: c.status,
              confidence: conf(c.confidence),
              rationale: c.rationale,
              observed_at: c.observed_at.toISOString(),
              evidence: evidence.get(c.id) ?? [],
            })),
            aliases: aliases.map((a) => a.alias),
            contact_points: contacts.map((c) => ({
              id: c.id,
              contact_type: c.contact_type,
              display_hint: c.display_hint,
              status: c.status,
              verification_method: c.verification_method,
              verified_at: c.verified_at?.toISOString() ?? null,
              claim_type: c.claim_type,
              confidence: conf(c.confidence),
              source_key: c.source_key,
            })),
            contact_points_note:
              'A contact is never labelled verified without a documented verification method and source. Pattern guesses stay unverified.',
            match_candidates: matches.map((m) => ({
              id: m.id,
              other_person_id: m.other_person_id,
              other_name: m.other_name,
              score: Number(m.score),
              rationale: m.rationale,
              status: m.status,
            })),
            merges: merges.map((m) => ({
              ...m,
              undone_at: m.undone_at?.toISOString() ?? null,
            })),
            reviews: reviews.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
          };
        });
      },
    );

    app.post(
      '/people/:id/review',
      {
        schema: {
          tags: ['people'],
          params: z.object({ id: z.uuid() }),
          body: z.object({
            decision: z.enum(['confirm', 'reject', 'dispute']),
            reason: z.string().trim().max(2000).optional(),
            expected_version: z.number().int().min(1),
          }),
          response: {
            200: z.object({ id: z.string(), review_status: z.string(), version: z.number() }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.review');
        const status = ({ confirm: 'accepted', reject: 'rejected', dispute: 'disputed' } as const)[
          request.body.decision
        ];
        return withContext(db, ctx, async (trx) => {
          const updated = await trx
            .updateTable('people')
            .set((eb) => ({
              review_status: status,
              reviewed_by: ctx.userId,
              reviewed_at: new Date(),
              version: eb('version', '+', 1),
            }))
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .where('version', '=', request.body.expected_version)
            .returning(['id', 'review_status', 'version'])
            .executeTakeFirst();
          if (!updated) {
            const exists = await trx
              .selectFrom('people')
              .select('id')
              .where('tenant_id', '=', ctx.tenantId)
              .where('id', '=', request.params.id)
              .executeTakeFirst();
            if (!exists) throw notFound('Person');
            throw new AppError('CONFLICT', 'Person was modified; reload and retry.');
          }
          await trx
            .insertInto('person_reviews')
            .values({
              tenant_id: ctx.tenantId,
              person_id: updated.id,
              decision: status,
              reason: request.body.reason ?? null,
              actor_user_id: ctx.userId,
            })
            .execute();
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'person.reviewed',
            entityType: 'person',
            entityId: updated.id,
            correlationId: ctx.correlationId,
            metadata: { decision: status },
          });
          return updated;
        });
      },
    );

    app.get(
      '/people/match-candidates',
      {
        schema: {
          tags: ['people'],
          response: {
            200: z.object({
              data: z.array(
                z.object({
                  id: z.string(),
                  person_a_id: z.string(),
                  person_b_id: z.string(),
                  person_a_name: z.string(),
                  person_b_name: z.string(),
                  score: z.number(),
                  rationale: z.string(),
                  status: z.string(),
                }),
              ),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.read');
        const rows = await withContext(db, ctx, async (trx) =>
          trx
            .selectFrom('match_candidates as m')
            .innerJoin('people as a', 'a.id', 'm.person_a_id')
            .innerJoin('people as b', 'b.id', 'm.person_b_id')
            .select([
              'm.id',
              'm.person_a_id',
              'm.person_b_id',
              'a.canonical_name as person_a_name',
              'b.canonical_name as person_b_name',
              'm.score',
              'm.rationale',
              'm.status',
            ])
            .where('m.tenant_id', '=', ctx.tenantId)
            .where('m.status', '=', 'proposed')
            .orderBy('m.created_at', 'desc')
            .limit(100)
            .execute(),
        );
        return {
          data: rows.map((r) => ({ ...r, score: Number(r.score) })),
        };
      },
    );

    app.post(
      '/people/match-candidates/:id/accept',
      {
        schema: {
          tags: ['people'],
          params: z.object({ id: z.uuid() }),
          body: z.object({ survivor_person_id: z.uuid() }),
          response: {
            200: z.object({
              id: z.string(),
              survivor_id: z.string(),
              absorbed_id: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.merge');
        return withContext(db, ctx, async (trx) =>
          acceptMatch(trx, {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            correlationId: ctx.correlationId,
            matchId: request.params.id,
            survivorId: request.body.survivor_person_id,
          }),
        );
      },
    );

    app.post(
      '/people/match-candidates/:id/reject',
      {
        schema: {
          tags: ['people'],
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ id: z.string(), status: z.string() }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.merge');
        return withContext(db, ctx, async (trx) => {
          const updated = await trx
            .updateTable('match_candidates')
            .set({ status: 'rejected', resolved_at: new Date(), resolved_by: ctx.userId })
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .where('status', '=', 'proposed')
            .returning(['id', 'status'])
            .executeTakeFirst();
          if (!updated) throw notFound('Match candidate');
          await recordAudit(trx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: 'person.match_rejected',
            entityType: 'match_candidate',
            entityId: updated.id,
            correlationId: ctx.correlationId,
          });
          return updated;
        });
      },
    );

    app.post(
      '/people/merges/:id/split',
      {
        schema: {
          tags: ['people'],
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              id: z.string(),
              survivor_id: z.string(),
              absorbed_id: z.string(),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'people.merge');
        return withContext(db, ctx, async (trx) =>
          splitMerge(trx, {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            correlationId: ctx.correlationId,
            mergeId: request.params.id,
          }),
        );
      },
    );
  };
