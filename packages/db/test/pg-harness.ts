import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { migrate } from '../src/migrate.ts';

export const APP_PASSWORD = 'test-app-pw';
export const RELAY_PASSWORD = 'test-relay-pw';

export interface PgHarness {
  container: StartedPostgreSqlContainer;
  ownerUrl: string;
  appUrl: string;
  relayUrl: string;
  stop(): Promise<void>;
}

function urlFor(c: StartedPostgreSqlContainer, user: string, password: string): string {
  return `postgres://${user}:${password}@${c.getHost()}:${c.getPort()}/${c.getDatabase()}`;
}

/** Starts a throwaway Postgres, provisions runtime roles and applies all migrations. */
export async function startPg(): Promise<PgHarness> {
  const container = await new PostgreSqlContainer('postgres:16.15-alpine')
    .withDatabase('mapforce')
    .withUsername('mapforce_owner')
    .withPassword('test-owner-pw')
    .start();
  const ownerUrl = container.getConnectionUri();

  const admin = new pg.Client({ connectionString: ownerUrl });
  await admin.connect();
  await admin.query(`
    CREATE ROLE app_rw NOLOGIN NOBYPASSRLS;
    CREATE ROLE app_relay NOLOGIN NOBYPASSRLS;
    CREATE ROLE mapforce_app LOGIN NOBYPASSRLS PASSWORD '${APP_PASSWORD}' IN ROLE app_rw;
    CREATE ROLE mapforce_relay LOGIN NOBYPASSRLS PASSWORD '${RELAY_PASSWORD}' IN ROLE app_relay;
  `);
  await admin.end();

  await migrate(ownerUrl);

  return {
    container,
    ownerUrl,
    appUrl: urlFor(container, 'mapforce_app', APP_PASSWORD),
    relayUrl: urlFor(container, 'mapforce_relay', RELAY_PASSWORD),
    stop: async () => {
      await container.stop();
    },
  };
}
