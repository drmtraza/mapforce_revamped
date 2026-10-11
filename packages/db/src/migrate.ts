import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const MIGRATION_LOCK_ID = 727_001;
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies forward-only SQL migrations in filename order, each in its own transaction.
 * Already-applied migrations are verified by checksum so edited history fails loudly.
 */
export async function migrate(
  connectionString: string,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    const files = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f)).sort();

    for (const file of files) {
      const sqlText = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sqlText).digest('hex');
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied`);
        }
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}
