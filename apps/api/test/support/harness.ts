import pg from 'pg';
import { createDb, type Db } from '@mapforce/db';
import { startPg, type PgHarness } from '@mapforce/db/testing';
import { buildApp, CSRF_HEADER, type App } from '../../src/app.ts';
import type { IdentityProvider } from '../../src/auth/idp.ts';
import { createSession, SESSION_COOKIE, upsertUser } from '../../src/auth/sessions.ts';
import { loadConfig } from '../../src/config.ts';
import type { EvidenceStorage } from '../../src/modules/evidence/storage.ts';
import type { ResearchDispatcher } from '../../src/temporal/dispatcher.ts';
import type { ResearchWorkflowInput } from '../../src/temporal/types.ts';
import { baseEnv } from './env.ts';

export class MemoryStorage implements EvidenceStorage {
  objects = new Map<string, string>();
  async ensureBucket() {}
  async put(key: string, body: string) {
    this.objects.set(key, body);
  }
  async signedGetUrl(key: string, ttl: number) {
    return `https://storage.test/${key}?X-Amz-Expires=${ttl}`;
  }
}

export class RecordingDispatcher implements ResearchDispatcher {
  started: ResearchWorkflowInput[] = [];
  cancelled: string[] = [];
  failNext = 0;
  async start(input: ResearchWorkflowInput) {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('temporal unavailable');
    }
    this.started.push(input);
  }
  async cancel(workflowId: string) {
    this.cancelled.push(workflowId);
  }
}

export const fakeIdp: IdentityProvider = {
  async createLogin() {
    return {
      authorizationUrl: 'http://idp.test/auth?state=s',
      checks: { state: 's', nonce: 'n', codeVerifier: 'v'.repeat(43) },
    };
  },
  async completeLogin(url) {
    if (url.searchParams.get('code') !== 'good') throw new Error('bad code');
    return {
      issuer: 'http://idp.test',
      subject: 'carol',
      email: 'carol@tenant-c.test',
      displayName: 'Carol',
    };
  },
};

export interface TestEnv {
  pg: PgHarness;
  db: Db;
  relayDb: Db;
  app: App;
  storage: MemoryStorage;
  dispatcher: RecordingDispatcher;
  owner: pg.Client;
  close(): Promise<void>;
}

export async function startTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const pgh = await startPg();
  const db = createDb({ connectionString: pgh.appUrl });
  const relayDb = createDb({ connectionString: pgh.relayUrl });
  const storage = new MemoryStorage();
  const dispatcher = new RecordingDispatcher();
  const config = loadConfig(baseEnv({ DATABASE_APP_URL: pgh.appUrl, ...overrides }));
  const app = await buildApp({ config, db, storage, dispatcher, idp: fakeIdp, logger: false });
  await app.ready();
  const owner = new pg.Client({ connectionString: pgh.ownerUrl });
  await owner.connect();
  return {
    pg: pgh,
    db,
    relayDb,
    app,
    storage,
    dispatcher,
    owner,
    close: async () => {
      await app.close();
      await owner.end();
      await db.destroy();
      await relayDb.destroy();
      await pgh.stop();
    },
  };
}

export interface Actor {
  userId: string;
  cookie: string;
  workspaceId?: string;
}

export async function signIn(env: TestEnv, subject: string, email: string): Promise<Actor> {
  const userId = await upsertUser(env.db, {
    issuer: 'http://idp.test',
    subject,
    email,
    displayName: subject,
  });
  const { token } = await createSession(env.db, userId, 1);
  return { userId, cookie: `${SESSION_COOKIE}=${env.app.signCookie(token)}` };
}

type Method = 'GET' | 'POST' | 'PATCH';

/** Issues an authenticated request as `actor`, scoped to `workspaceId` (or the actor's own). */
export async function call(
  env: TestEnv,
  actor: Actor | null,
  method: Method,
  url: string,
  opts: { body?: unknown; workspaceId?: string | null; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (actor) headers.cookie = actor.cookie;
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  const ws = opts.workspaceId === undefined ? actor?.workspaceId : opts.workspaceId;
  if (ws) headers['x-workspace-id'] = ws;
  const res = await env.app.inject({
    method,
    url,
    headers,
    ...(opts.body !== undefined ? { payload: opts.body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers };
}
