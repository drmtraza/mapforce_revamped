import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

export type * from './schema.ts';
export { migrate, MIGRATIONS_DIR } from './migrate.ts';
export { sql };

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export interface DbContext {
  tenantId: string | null;
  userId: string | null;
}

export interface CreateDbOptions {
  connectionString: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
}

const pools = new WeakMap<Db, pg.Pool>();

export function createDb(opts: CreateDbOptions): Db {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.maxConnections ?? 10,
    statement_timeout: opts.statementTimeoutMs ?? 10_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: opts.applicationName ?? 'mapforce',
  });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  pools.set(db, pool);
  return db;
}

export function poolStats(db: Db): { total: number; idle: number; waiting: number } | null {
  const pool = pools.get(db);
  if (!pool) return null;
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

/**
 * Runs `fn` in a transaction whose row-level-security context is bound to the
 * given tenant and user. All tenant-owned data access must go through here.
 */
export async function withContext<T>(
  db: Db,
  ctx: DbContext,
  fn: (trx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', ${ctx.tenantId ?? ''}, true),
                     set_config('app.user_id', ${ctx.userId ?? ''}, true)`.execute(trx);
    return fn(trx);
  });
}
