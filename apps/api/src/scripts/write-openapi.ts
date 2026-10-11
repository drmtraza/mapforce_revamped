import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { createDb } from '@mapforce/db';
import type { EvidenceStorage } from '../modules/evidence/storage.ts';

// Generates the OpenAPI document without touching any backing service; pools connect lazily.
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_APP_URL: 'postgres://openapi:openapi@127.0.0.1:1/openapi',
  SESSION_COOKIE_SECRET: 'openapi-generation-only-not-a-secret-000',
  OIDC_ISSUER_URL: 'http://idp.invalid/realms/mapforce',
  OIDC_CLIENT_ID: 'mapforce-web',
  OIDC_REDIRECT_URI: 'http://localhost:4000/api/v1/auth/callback',
  S3_ENDPOINT: 'http://storage.invalid',
  S3_PUBLIC_ENDPOINT: 'http://storage.invalid',
  S3_BUCKET: 'evidence',
  S3_ACCESS_KEY_ID: 'unused',
  S3_SECRET_ACCESS_KEY: 'unused',
});
const unavailable = async (): Promise<never> => {
  throw new Error('not available during OpenAPI generation');
};
const storage: EvidenceStorage = {
  ensureBucket: unavailable,
  put: unavailable,
  signedGetUrl: unavailable,
};
const db = createDb({ connectionString: config.DATABASE_APP_URL });
const app = await buildApp({
  config,
  db,
  storage,
  idp: { createLogin: unavailable, completeLogin: unavailable },
  dispatcher: { start: unavailable, cancel: unavailable },
  logger: false,
});
await app.ready();

const out = new URL('../../../../contracts/openapi.v1.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
await db.destroy();
process.stdout.write(`wrote ${fileURLToPath(out)}\n`);
