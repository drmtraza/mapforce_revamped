import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withContext } from '../src/index.ts';
import { startPg, type PgHarness } from './pg-harness.ts';

let source: PgHarness;

beforeAll(async () => {
  source = await startPg();
  const db = createDb({ connectionString: source.appUrl });
  const tenantId = '11111111-1111-4111-8111-111111111111';
  await withContext(db, { tenantId, userId: null }, async (trx) => {
    await trx.insertInto('tenants').values({ id: tenantId, name: 'Restore drill' }).execute();
    await trx
      .insertInto('companies')
      .values({
        tenant_id: tenantId,
        canonical_name: 'Restore Co',
        primary_domain: 'restore.example',
        created_by: null,
      })
      .execute();
  });
  await db.destroy();
}, 180_000);

afterAll(async () => {
  await source?.stop();
});

describe('backup restore drill', () => {
  it('restores a pg_dump into a fresh Postgres and finds the tenant row', async () => {
    const dump = await source.container.exec([
      'pg_dump',
      '-U',
      'mapforce_owner',
      '--no-owner',
      '--no-acl',
      'mapforce',
    ]);
    expect(dump.exitCode).toBe(0);
    expect(dump.output).toMatch(/CREATE TABLE public.companies/i);

    const dest = await new PostgreSqlContainer('postgres:16.15-alpine')
      .withDatabase('mapforce')
      .withUsername('mapforce_owner')
      .withPassword('restore-pw')
      .start();
    const started = Date.now();
    try {
      await dest.copyContentToContainer([{ content: dump.output, target: '/tmp/restore.sql' }]);
      const restore = await dest.exec([
        'psql',
        '-U',
        'mapforce_owner',
        '-d',
        'mapforce',
        '-v',
        'ON_ERROR_STOP=0',
        '-f',
        '/tmp/restore.sql',
      ]);
      expect(restore.exitCode).toBe(0);
      const client = new pg.Client({ connectionString: dest.getConnectionUri() });
      await client.connect();
      const { rows } = await client.query<{ n: number; name: string }>(
        `SELECT count(*)::int AS n, max(canonical_name) AS name FROM companies`,
      );
      await client.end();
      expect(rows[0]!.n).toBeGreaterThan(0);
      expect(rows[0]!.name).toBe('Restore Co');
      expect(Date.now() - started).toBeLessThan(120_000);
    } finally {
      await dest.stop();
    }
  }, 180_000);
});
