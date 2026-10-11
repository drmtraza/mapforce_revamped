import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrate, withContext, type Db } from '../src/index.ts';
import { startPg, type PgHarness } from './pg-harness.ts';

let h: PgHarness;
let db: Db;
const tenantA = randomUUID();
const tenantB = randomUUID();
let userA = '';
let userB = '';

beforeAll(async () => {
  h = await startPg();
  db = createDb({ connectionString: h.appUrl });

  const owner = new pg.Client({ connectionString: h.ownerUrl });
  await owner.connect();
  const res = await owner.query<{ id: string }>(
    `INSERT INTO users (idp_issuer, idp_subject, email) VALUES
       ('test', 'a', 'a@tenant-a.test'), ('test', 'b', 'b@tenant-b.test') RETURNING id`,
  );
  userA = res.rows[0]!.id;
  userB = res.rows[1]!.id;
  await owner.end();

  for (const [tenantId, userId, name] of [
    [tenantA, userA, 'Tenant A'],
    [tenantB, userB, 'Tenant B'],
  ] as const) {
    await withContext(db, { tenantId, userId }, async (trx) => {
      await trx.insertInto('tenants').values({ id: tenantId, name }).execute();
      await trx
        .insertInto('memberships')
        .values({ tenant_id: tenantId, user_id: userId, role: 'owner' })
        .execute();
      await trx
        .insertInto('companies')
        .values({
          tenant_id: tenantId,
          canonical_name: `${name} Target`,
          primary_domain: `${tenantId.slice(0, 8)}.example`,
          created_by: userId,
        })
        .execute();
    });
  }
}, 180_000);

afterAll(async () => {
  await db?.destroy();
  await h?.stop();
});

describe('migrations', () => {
  it('are idempotent and checksum-verified on re-run', async () => {
    const second = await migrate(h.ownerUrl);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(5);
  });

  it('force row-level security on every table with a tenant_id column', async () => {
    const owner = new pg.Client({ connectionString: h.ownerUrl });
    await owner.connect();
    const { rows } = await owner.query<{ table_name: string; rls: boolean; forced: boolean }>(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM information_schema.columns col
                    WHERE col.table_schema = 'public' AND col.table_name = c.relname
                      AND col.column_name = 'tenant_id')`);
    await owner.end();
    expect(rows.length).toBeGreaterThan(15);
    const unprotected = rows.filter((r) => !r.rls || !r.forced).map((r) => r.table_name);
    expect(unprotected).toEqual([]);
  });

  it('runtime role cannot bypass RLS', async () => {
    const app = new pg.Client({ connectionString: h.appUrl });
    await app.connect();
    const { rows } = await app.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    await app.end();
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});

describe('tenant isolation (database layer)', () => {
  it('returns only the current tenant rows', async () => {
    const seenByA = await withContext(db, { tenantId: tenantA, userId: userA }, (trx) =>
      trx.selectFrom('companies').select(['tenant_id']).execute(),
    );
    expect(seenByA.map((r) => r.tenant_id)).toEqual([tenantA]);
  });

  it('returns nothing when no tenant context is set', async () => {
    const rows = await withContext(db, { tenantId: null, userId: null }, (trx) =>
      trx.selectFrom('companies').selectAll().execute(),
    );
    expect(rows).toEqual([]);
  });

  it('rejects writes into another tenant', async () => {
    await expect(
      withContext(db, { tenantId: tenantB, userId: userB }, (trx) =>
        trx
          .insertInto('companies')
          .values({ tenant_id: tenantA, canonical_name: 'Injected', primary_domain: 'x.example' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot update another tenant rows', async () => {
    const result = await withContext(db, { tenantId: tenantB, userId: userB }, (trx) =>
      trx
        .updateTable('companies')
        .set({ canonical_name: 'Hijacked' })
        .where('tenant_id', '=', tenantA)
        .executeTakeFirst(),
    );
    expect(result.numUpdatedRows).toBe(0n);
  });

  it('lists only workspaces the user belongs to', async () => {
    const rows = await withContext(db, { tenantId: null, userId: userB }, (trx) =>
      trx.selectFrom('tenants').select(['id']).execute(),
    );
    expect(rows.map((r) => r.id)).toEqual([tenantB]);
  });

  it('prevents updating or deleting audit events', async () => {
    await withContext(db, { tenantId: tenantA, userId: userA }, (trx) =>
      trx
        .insertInto('audit_events')
        .values({
          tenant_id: tenantA,
          actor_user_id: userA,
          actor_type: 'user',
          action: 'test.action',
          entity_type: 'test',
          outcome: 'success',
          correlation_id: 'c1',
          metadata: '{}',
        })
        .execute(),
    );
    await expect(
      withContext(db, { tenantId: tenantA, userId: userA }, (trx) =>
        trx.deleteFrom('audit_events').execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('rejects source settings written for another tenant', async () => {
    await expect(
      withContext(db, { tenantId: tenantB, userId: userB }, (trx) =>
        trx
          .insertInto('tenant_source_settings')
          .values({
            tenant_id: tenantA,
            source_key: 'company_site',
            enabled: true,
            updated_by: userB,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('requires a company for research jobs but not for discovery jobs', async () => {
    const base = {
      tenant_id: tenantA,
      input: '{}',
      requested_by: userA,
    };
    await expect(
      withContext(db, { tenantId: tenantA, userId: userA }, (trx) =>
        trx
          .insertInto('workflow_jobs')
          .values({
            ...base,
            job_type: 'company_research',
            company_id: null,
            idempotency_key: 'r-null',
            temporal_workflow_id: `wf-${randomUUID()}`,
          })
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
    await withContext(db, { tenantId: tenantA, userId: userA }, (trx) =>
      trx
        .insertInto('workflow_jobs')
        .values({
          ...base,
          job_type: 'company_discovery',
          company_id: null,
          idempotency_key: 'd-null',
          temporal_workflow_id: `wf-${randomUUID()}`,
        })
        .execute(),
    );
  });

  it('lets the runtime role touch only delivery columns of outbox events', async () => {
    await expect(
      withContext(db, { tenantId: tenantA, userId: userA }, (trx) =>
        trx.updateTable('outbox_events').set({ payload: '{}' }).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await withContext(db, { tenantId: tenantA, userId: userA }, (trx) =>
      trx.updateTable('outbox_events').set({ dead_lettered_at: null, attempts: 0 }).execute(),
    );
  });

  it('rejects storing a model inference as a verified relationship', async () => {
    await expect(
      withContext(db, { tenantId: tenantA, userId: userA }, (trx) =>
        trx
          .insertInto('relationships')
          .values({
            tenant_id: tenantA,
            subject_type: 'person',
            subject_id: randomUUID(),
            predicate: 'REPORTS_TO',
            object_type: 'person',
            object_id: randomUUID(),
            status: 'verified',
            claim_type: 'model_inference',
            confidence: 0.9,
            rationale: 'test',
          })
          .execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
