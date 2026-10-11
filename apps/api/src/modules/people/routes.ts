import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext, type Tx } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';
import { loadCompany } from '../companies/routes.ts';
import { confidenceBand } from './confidence.ts';

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
    }),
  ),
  claims: z.array(Claim),
  contact_points: z.array(z.never()),
  contact_points_note: z.string(),
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
            .select(['id', 'canonical_name', 'public_profile_url', 'review_status', 'version'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!person) throw notFound('Person');

          const roles = await trx
            .selectFrom('employment_roles')
            .select(['id', 'company_id', 'title', 'department', 'seniority', 'status'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('person_id', '=', person.id)
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
            ...person,
            roles,
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
            contact_points: [],
            contact_points_note:
              'No contact points collected. Contact enrichment and verification arrive in Phase 3.',
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
  };
