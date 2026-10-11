import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import pino from 'pino';
import { createDb } from '@mapforce/db';
import { loadConfig } from '../config.ts';
import { loggerOptions } from '../logger.ts';
import { createS3Storage } from '../modules/evidence/storage.ts';
import { startRelayLoop } from '../modules/outbox/relay.ts';
import { createControlActivities } from './activities.ts';
import { createTemporalDispatcher } from './dispatcher.ts';

const config = loadConfig();
const logger = pino({
  ...loggerOptions(config.LOG_LEVEL),
  base: { service: 'mapforce-control-worker' },
});

if (!config.DATABASE_RELAY_URL) throw new Error('DATABASE_RELAY_URL is required for the worker');

const db = createDb({
  connectionString: config.DATABASE_APP_URL,
  maxConnections: config.DATABASE_POOL_MAX,
  applicationName: 'mapforce-control-worker',
});
const relayDb = createDb({
  connectionString: config.DATABASE_RELAY_URL,
  maxConnections: 2,
  applicationName: 'mapforce-outbox-relay',
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
if (config.NODE_ENV !== 'production') await storage.ensureBucket();

const clientConnection = await Connection.connect({ address: config.TEMPORAL_ADDRESS });
const dispatcher = createTemporalDispatcher(
  new Client({ connection: clientConnection, namespace: config.TEMPORAL_NAMESPACE }),
  config.TEMPORAL_TASK_QUEUE,
);

const worker = await Worker.create({
  connection: await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS }),
  namespace: config.TEMPORAL_NAMESPACE,
  taskQueue: config.TEMPORAL_TASK_QUEUE,
  workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
  activities: createControlActivities({ db, storage }),
  maxConcurrentActivityTaskExecutions: 20,
});

const relay = startRelayLoop(relayDb, dispatcher, logger);
logger.info({ taskQueue: config.TEMPORAL_TASK_QUEUE }, 'control worker and outbox relay started');

const shutdown = async () => {
  logger.info('shutting down');
  worker.shutdown();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await worker.run();
await relay.stop();
await clientConnection.close();
await Promise.all([db.destroy(), relayDb.destroy()]);
