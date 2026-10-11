import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { withContext, type Tx } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import { AppError, notFound } from '../../errors.ts';
import { requireTenant } from '../../http/context.ts';
import { decodeCursor, PageMeta, PageQuery, paginate } from '../../http/pagination.ts';
import { recordAudit } from '../audit/service.ts';
import { isUniqueViolation, parseIdempotencyKey } from '../jobs/service.ts';
import { enqueueEvent } from '../outbox/service.ts';
import { analyzeCompanyCsv, IMPORT_MAX_BYTES, summarize, type AnalyzedRow } from './service.ts';

const PREVIEW_ROWS = 1000;
const CHUNK = 500;

const Summary = z.object({
  rows: z.number(),
  created: z.number(),
  existing: z.number(),
  duplicate_in_file: z.number(),
  invalid: z.number(),
});

const Row = z.object({
  row_number: z.number(),
  domain: z.string().nullable(),
  name: z.string().nullable(),
  normalized_domain: z.string().nullable(),
  outcome: z.enum(['created', 'existing', 'duplicate_in_file', 'invalid']),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  company_id: z.string().nullable(),
});

const ImportResult = z.object({
  import_id: z.string().nullable(),
  dry_run: z.boolean(),
  replayed: z.boolean(),
  summary: Summary,
  ignored_columns: z.array(z.string()),
  rows: z.array(Row),
  rows_truncated: z.boolean(),
});

const Batch = z.object({
  id: z.string(),
  filename: z.string().nullable(),
  content_hash: z.string(),
  summary: Summary,
  created_by: z.string(),
  created_at: z.string(),
});

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const toRowDto = (r: AnalyzedRow) => ({
  row_number: r.row_number,
  domain: r.raw.domain ?? null,
  name: r.raw.name ?? null,
  normalized_domain: r.normalized_domain,
  outcome: r.outcome,
  error_code: r.error_code,
  error_message: r.error_message,
  company_id: r.company_id,
});

async function markExisting(trx: Tx, tenantId: string, rows: AnalyzedRow[]) {
  const candidates = rows.filter((r) => r.outcome === 'created' && r.normalized_domain);
  for (const part of chunks(candidates, 1000)) {
    const found = await trx
      .selectFrom('companies')
      .select(['id', 'primary_domain'])
      .where('tenant_id', '=', tenantId)
      .where(
        'primary_domain',
        'in',
        part.map((r) => r.normalized_domain as string),
      )
      .execute();
    const byDomain = new Map(found.map((f) => [f.primary_domain, f.id]));
    for (const r of part) {
      const id = byDomain.get(r.normalized_domain as string);
      if (id) {
        r.outcome = 'existing';
        r.company_id = id;
        r.error_message = 'Company already exists in this workspace.';
      }
    }
  }
}

const batchDto = (b: {
  id: string;
  filename: string | null;
  content_hash: string;
  row_count: number;
  created_count: number;
  existing_count: number;
  duplicate_count: number;
  invalid_count: number;
  created_by: string;
  created_at: Date;
}) => ({
  id: b.id,
  filename: b.filename,
  content_hash: b.content_hash,
  summary: {
    rows: b.row_count,
    created: b.created_count,
    existing: b.existing_count,
    duplicate_in_file: b.duplicate_count,
    invalid: b.invalid_count,
  },
  created_by: b.created_by,
  created_at: b.created_at.toISOString(),
});

export const importRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.addContentTypeParser(
      'text/csv',
      { parseAs: 'string', bodyLimit: IMPORT_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );

    app.post(
      '/imports/companies',
      {
        bodyLimit: IMPORT_MAX_BYTES,
        schema: {
          tags: ['imports'],
          consumes: ['text/csv'],
          querystring: z.object({
            dry_run: z.enum(['true', 'false']).default('true'),
            filename: z.string().trim().max(255).optional(),
          }),
          body: z.string().min(1),
          response: { 200: ImportResult, 201: ImportResult },
        },
      },
      async (request, reply) => {
        const ctx = await requireTenant(db, request, 'import.write');
        const dryRun = request.query.dry_run === 'true';
        const key = parseIdempotencyKey(request.headers['idempotency-key']);
        if (!dryRun && !key) {
          throw new AppError('VALIDATION_ERROR', 'Idempotency-Key header is required to commit.');
        }
        const text = request.body;
        const contentHash = `sha256:${createHash('sha256').update(text).digest('hex')}`;
        const analyzed = analyzeCompanyCsv(text);
        const ignored = analyzed.ignored;

        const run = (rows: AnalyzedRow[]) =>
          withContext(db, ctx, async (trx) => {
            if (!dryRun) {
              const previous = await trx
                .selectFrom('import_batches')
                .selectAll()
                .where('tenant_id', '=', ctx.tenantId)
                .where('kind', '=', 'companies')
                .where('idempotency_key', '=', key as string)
                .executeTakeFirst();
              if (previous) {
                if (previous.content_hash !== contentHash) {
                  throw new AppError(
                    'CONFLICT',
                    'This Idempotency-Key was already used for a different file.',
                  );
                }
                const stored = await trx
                  .selectFrom('import_rows')
                  .select([
                    'row_number',
                    'raw',
                    'normalized_domain',
                    'outcome',
                    'error_code',
                    'error_message',
                    'company_id',
                  ])
                  .where('tenant_id', '=', ctx.tenantId)
                  .where('batch_id', '=', previous.id)
                  .orderBy('row_number')
                  .limit(PREVIEW_ROWS)
                  .execute();
                return {
                  status: 200 as const,
                  body: {
                    import_id: previous.id,
                    dry_run: false,
                    replayed: true,
                    summary: batchDto(previous).summary,
                    ignored_columns: ignored,
                    rows: stored.map((r) => {
                      const raw = r.raw as { domain?: string; name?: string };
                      return {
                        row_number: r.row_number,
                        domain: raw.domain ?? null,
                        name: raw.name ?? null,
                        normalized_domain: r.normalized_domain,
                        outcome: r.outcome,
                        error_code: r.error_code,
                        error_message: r.error_message,
                        company_id: r.company_id,
                      };
                    }),
                    rows_truncated: previous.row_count > PREVIEW_ROWS,
                  },
                };
              }
            }

            await markExisting(trx, ctx.tenantId, rows);
            if (dryRun) {
              return {
                status: 200 as const,
                body: {
                  import_id: null,
                  dry_run: true,
                  replayed: false,
                  summary: summarize(rows),
                  ignored_columns: ignored,
                  rows: rows.slice(0, PREVIEW_ROWS).map(toRowDto),
                  rows_truncated: rows.length > PREVIEW_ROWS,
                },
              };
            }

            const batch = { id: randomUUID() };
            const toCreate = rows.filter((r) => r.outcome === 'created');
            for (const part of chunks(toCreate)) {
              const inserted = await trx
                .insertInto('companies')
                .values(
                  part.map((r) => ({
                    tenant_id: ctx.tenantId,
                    canonical_name: r.name ?? (r.normalized_domain as string),
                    primary_domain: r.normalized_domain as string,
                    country_code: r.country_code,
                    industry: r.industry,
                    created_by: ctx.userId,
                  })),
                )
                .onConflict((oc) => oc.columns(['tenant_id', 'primary_domain']).doNothing())
                .returning(['id', 'primary_domain'])
                .execute();
              const ids = new Map(inserted.map((c) => [c.primary_domain, c.id]));
              for (const r of part) {
                r.company_id = ids.get(r.normalized_domain as string) ?? null;
              }
            }
            // Rows that lost an insert race to a concurrent writer become `existing`.
            await markExisting(
              trx,
              ctx.tenantId,
              rows.filter((r) => r.outcome === 'created' && !r.company_id),
            );
            const summary = summarize(rows);
            await trx
              .insertInto('import_batches')
              .values({
                id: batch.id,
                tenant_id: ctx.tenantId,
                kind: 'companies',
                idempotency_key: key as string,
                filename: request.query.filename ?? null,
                content_hash: contentHash,
                row_count: rows.length,
                created_count: summary.created,
                existing_count: summary.existing,
                duplicate_count: summary.duplicate_in_file,
                invalid_count: summary.invalid,
                created_by: ctx.userId,
              })
              .execute();

            // Imported values are the user's assertions; the batch row is their provenance.
            const claims = rows
              .filter((r) => r.outcome === 'created' && r.company_id)
              .flatMap((r) =>
                (
                  [
                    ['canonical_name', r.name],
                    ['country_code', r.country_code],
                    ['industry', r.industry],
                  ] as const
                )
                  .filter(([, v]) => v)
                  .map(([predicate, value]) => ({
                    tenant_id: ctx.tenantId,
                    subject_type: 'company' as const,
                    subject_id: r.company_id as string,
                    predicate,
                    object_value: JSON.stringify(value),
                    claim_type: 'user_assertion' as const,
                    confidence: 1,
                    rationale: `Imported from CSV batch ${batch.id}, row ${r.row_number}.`,
                    observed_at: new Date(),
                  })),
              );
            for (const part of chunks(claims)) {
              await trx.insertInto('claims').values(part).execute();
            }
            for (const part of chunks(rows)) {
              await trx
                .insertInto('import_rows')
                .values(
                  part.map((r) => ({
                    tenant_id: ctx.tenantId,
                    batch_id: batch.id,
                    row_number: r.row_number,
                    raw: JSON.stringify(r.raw),
                    normalized_domain: r.normalized_domain,
                    outcome: r.outcome,
                    error_code: r.error_code,
                    error_message: r.error_message,
                    company_id: r.company_id,
                  })),
                )
                .execute();
            }
            await enqueueEvent(trx, {
              tenantId: ctx.tenantId,
              eventType: 'company.import.completed',
              correlationId: ctx.correlationId,
              idempotencyKey: batch.id,
              payload: { import_id: batch.id, ...summary },
            });
            await recordAudit(trx, {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              action: 'import.companies_committed',
              entityType: 'import_batch',
              entityId: batch.id,
              correlationId: ctx.correlationId,
              metadata: { ...summary, content_hash: contentHash },
            });
            return {
              status: 201 as const,
              body: {
                import_id: batch.id,
                dry_run: false,
                replayed: false,
                summary,
                ignored_columns: ignored,
                rows: rows.slice(0, PREVIEW_ROWS).map(toRowDto),
                rows_truncated: rows.length > PREVIEW_ROWS,
              },
            };
          });

        let result;
        try {
          result = await run(analyzed.rows);
        } catch (err) {
          // A concurrent commit with the same key won; the retry replays its result.
          if (!isUniqueViolation(err)) throw err;
          result = await run(analyzeCompanyCsv(text).rows);
        }
        return reply.status(result.status).send(result.body);
      },
    );

    app.get(
      '/imports',
      {
        schema: {
          tags: ['imports'],
          querystring: PageQuery,
          response: { 200: z.object({ data: z.array(Batch), ...PageMeta }) },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'import.read');
        const { limit } = request.query;
        const cursor = decodeCursor(request.query.cursor);
        const rows = await withContext(db, ctx, (trx) => {
          let q = trx
            .selectFrom('import_batches')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId);
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
        return { data: page.map(batchDto), ...meta };
      },
    );

    app.get(
      '/imports/:id',
      {
        schema: {
          tags: ['imports'],
          params: z.object({ id: z.uuid() }),
          querystring: z.object({
            outcome: z.enum(['created', 'existing', 'duplicate_in_file', 'invalid']).optional(),
            after_row: z.coerce.number().int().min(0).default(0),
            limit: z.coerce.number().int().min(1).max(500).default(100),
          }),
          response: {
            200: Batch.extend({ rows: z.array(Row), next_after_row: z.number().nullable() }),
          },
        },
      },
      async (request) => {
        const ctx = await requireTenant(db, request, 'import.read');
        const { outcome, after_row: afterRow, limit } = request.query;
        return withContext(db, ctx, async (trx) => {
          const batch = await trx
            .selectFrom('import_batches')
            .selectAll()
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!batch) throw notFound('Import');
          let q = trx
            .selectFrom('import_rows')
            .select([
              'row_number',
              'raw',
              'normalized_domain',
              'outcome',
              'error_code',
              'error_message',
              'company_id',
            ])
            .where('tenant_id', '=', ctx.tenantId)
            .where('batch_id', '=', batch.id)
            .where('row_number', '>', afterRow);
          if (outcome) q = q.where('outcome', '=', outcome);
          const rows = await q
            .orderBy('row_number')
            .limit(limit + 1)
            .execute();
          const page = rows.slice(0, limit);
          return {
            ...batchDto(batch),
            rows: page.map((r) => {
              const raw = r.raw as { domain?: string; name?: string };
              return {
                row_number: r.row_number,
                domain: raw.domain ?? null,
                name: raw.name ?? null,
                normalized_domain: r.normalized_domain,
                outcome: r.outcome,
                error_code: r.error_code,
                error_message: r.error_message,
                company_id: r.company_id,
              };
            }),
            next_after_row:
              rows.length > limit ? (page[page.length - 1]?.row_number ?? null) : null,
          };
        });
      },
    );
  };
