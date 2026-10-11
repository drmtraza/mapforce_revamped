import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext, type Tx } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { normalizeDomain } from '../../domain.ts';
import { notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { decodeCursor, PageMeta, PageQuery, paginate } from '../../http/pagination.ts';
import { recordAudit } from '../audit/service.ts';

export const Company = z.object({
  id: z.string(),
  canonical_name: z.string(),
  primary_domain: z.string(),
  country_code: z.string().nullable(),
  industry: z.string().nullable(),
  employee_band: z.string().nullable(),
  description: z.string().nullable(),
  lifecycle_status: z.string(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

const COLUMNS = [
  'id',
  'canonical_name',
  'primary_domain',
  'country_code',
  'industry',
  'employee_band',
  'description',
  'lifecycle_status',
  'version',
  'created_at',
  'updated_at',
] as const;

type CompanyRow = {
  created_at: Date;
  updated_at: Date;
} & Record<Exclude<(typeof COLUMNS)[number], 'created_at' | 'updated_at'>, unknown>;

export const toCompanyDto = (r: CompanyRow) =>
  Company.parse({
    ...r,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  });

export async function loadCompany(trx: Tx, tenantId: string, id: string) {
  const row = await trx
    .selectFrom('companies')
    .select(COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Company');
  return row;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const companyRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.post(
      '/companies',
      {
        schema: {
          tags: ['companies'],
          body: z.object({
            domain: z.string().min(1).max(300),
            name: z.string().trim().min(1).max(300).optional(),
          }),
          response: {
            200: z.object({ created: z.literal(false), company: Company }),
            201: z.object({ created: z.literal(true), company: Company }),
          },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'company.write');
        const domain = normalizeDomain(request.body.domain);
        const result = await withContext(db, ctx, async (trx) => {
          const inserted = await trx
            .insertInto('companies')
            .values({
              tenant_id: ctx.tenantId,
              canonical_name: request.body.name ?? domain,
              primary_domain: domain,
              created_by: ctx.userId,
            })
            .onConflict((oc) => oc.columns(['tenant_id', 'primary_domain']).doNothing())
            .returning(COLUMNS)
            .executeTakeFirst();
          if (inserted) {
            await recordAudit(trx, {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              action: 'company.created',
              entityType: 'company',
              entityId: inserted.id,
              correlationId: ctx.correlationId,
              metadata: { domain },
            });
            return { created: true as const, row: inserted };
          }
          const existing = await trx
            .selectFrom('companies')
            .select(COLUMNS)
            .where('tenant_id', '=', ctx.tenantId)
            .where('primary_domain', '=', domain)
            .executeTakeFirstOrThrow();
          return { created: false as const, row: existing };
        });
        const company = toCompanyDto(result.row);
        return result.created
          ? reply.status(201).send({ created: true, company })
          : reply.status(200).send({ created: false, company });
      },
    );

    app.get(
      '/companies',
      {
        schema: {
          tags: ['companies'],
          querystring: PageQuery.extend({ query: z.string().trim().max(200).optional() }),
          response: { 200: z.object({ data: z.array(Company), ...PageMeta }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        const { limit, query } = request.query;
        const cursor = decodeCursor(request.query.cursor);
        const rows = await withContext(db, ctx, (trx) => {
          let q = trx.selectFrom('companies').select(COLUMNS).where('tenant_id', '=', ctx.tenantId);
          if (query) {
            const pattern = `%${escapeLike(query)}%`;
            q = q.where((eb) =>
              eb.or([
                eb('canonical_name', 'ilike', pattern),
                eb('primary_domain', 'ilike', pattern),
              ]),
            );
          }
          if (cursor) {
            q = q.where((eb) =>
              eb.or([
                eb('created_at', '<', new Date(cursor.t)),
                eb.and([eb('created_at', '=', new Date(cursor.t)), eb('id', '<', cursor.id)]),
              ]),
            );
          }
          return q
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .limit(limit + 1)
            .execute();
        });
        const { page, ...meta } = paginate(rows, limit);
        return { data: page.map(toCompanyDto), ...meta };
      },
    );

    app.get(
      '/companies/:id',
      {
        schema: {
          tags: ['companies'],
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              company: Company,
              latest_job: z
                .object({ id: z.string(), status: z.string(), created_at: z.string() })
                .nullable(),
              counts: z.object({ evidence: z.number(), people: z.number() }),
            }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'company.read');
        return withContext(db, ctx, async (trx) => {
          const row = await loadCompany(trx, ctx.tenantId, request.params.id);
          const job = await trx
            .selectFrom('workflow_jobs')
            .select(['id', 'status', 'created_at'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', row.id)
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst();
          const evidence = await trx
            .selectFrom('evidence_records')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', row.id)
            .executeTakeFirstOrThrow();
          const people = await trx
            .selectFrom('person_company_links')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('tenant_id', '=', ctx.tenantId)
            .where('company_id', '=', row.id)
            .executeTakeFirstOrThrow();
          return {
            company: toCompanyDto(row),
            latest_job: job ? { ...job, created_at: job.created_at.toISOString() } : null,
            counts: { evidence: Number(evidence.n), people: Number(people.n) },
          };
        });
      },
    );
  };
