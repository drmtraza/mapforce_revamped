import { Client, Connection } from '@temporalio/client';
import { Redis } from 'ioredis';
import { createDb } from '@mapforce/db';
import { buildApp } from './app.ts';
import { createOidcProvider } from './auth/oidc.ts';
import { loadConfig } from './config.ts';
import { createS3Storage } from './modules/evidence/storage.ts';
import { createTemporalDispatcher } from './temporal/dispatcher.ts';

const config = loadConfig();

const db = createDb({
  connectionString: config.DATABASE_APP_URL,
  maxConnections: config.DATABASE_POOL_MAX,
  applicationName: 'mapforce-api',
});
const storage = createS3Storage({
  endpoint: config.S3_ENDPOINT,
  publicEndpoint: config.S3_PUBLIC_ENDPOINT,
  region: config.S3_REGION,
  bucket: config.S3_BUCKET,
  accessKeyId: config.S3_ACCESS_KEY_ID,
  secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
});
const connection = Connection.lazy({ address: config.TEMPORAL_ADDRESS });
const dispatcher = createTemporalDispatcher(
  new Client({ connection, namespace: config.TEMPORAL_NAMESPACE }),
  config.TEMPORAL_TASK_QUEUE,
);
const redis = config.REDIS_URL
  ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false })
  : undefined;

const app = await buildApp({
  config,
  db,
  storage,
  dispatcher,
  redis,
  idp: createOidcProvider({
    issuerUrl: config.OIDC_ISSUER_URL,
    clientId: config.OIDC_CLIENT_ID,
    redirectUri: config.OIDC_REDIRECT_URI,
    allowInsecureHttp: config.OIDC_ALLOW_INSECURE_HTTP,
  }),
});

const shutdown = async () => {
  await app.close();
  await connection.close();
  redis?.disconnect();
  await db.destroy();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.API_HOST, port: config.API_PORT });
