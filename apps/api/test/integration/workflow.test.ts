import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { DefaultLogger, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relayOnce } from '../../src/modules/outbox/relay.ts';
import { createControlActivities } from '../../src/temporal/activities.ts';
import {
  createTemporalDispatcher,
  researchWorkflowId,
  type ResearchDispatcher,
} from '../../src/temporal/dispatcher.ts';
import type { AdapterInvocation, AdapterRequest } from '../../src/temporal/types.ts';
import {
  careersResult,
  peopleResult,
  procurementResult,
  webResult,
} from '../support/adapter-fixtures.ts';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

const CONTROL_QUEUE = 'research-control-test';
const PYTHON_QUEUE = 'research-python-test';
const TERMINAL = ['succeeded', 'partial_success', 'failed', 'cancelled'];
const silent = { warn: () => undefined, error: () => undefined };

let temporal: StartedTestContainer;
let connection: Connection;
let env: TestEnv;
let dispatcher: ResearchDispatcher;
let controlWorker: Worker;
let pythonWorker: Worker;
let running: Promise<unknown>;
let alice: Actor;
const adapterCalls: AdapterRequest[] = [];
let releaseSlowAdapters: () => void = () => undefined;
const slowGate = new Promise<void>((resolve) => {
  releaseSlowAdapters = resolve;
});

/** Stands in for the Python worker: same activity name, queue routing and failure semantics. */
async function runAdapter(request: AdapterRequest): Promise<AdapterInvocation> {
  adapterCalls.push(request);
  const domain = request.company?.domain ?? '';
  if (domain.startsWith('slow.')) await slowGate;
  switch (request.source_key) {
    case 'mock_web':
      return { attempt: 1, result: webResult(domain) };
    case 'mock_people':
      return { attempt: 1, result: peopleResult(domain) };
    case 'mock_careers':
      return { attempt: 1, result: careersResult(domain) };
    case 'mock_procurement':
      return { attempt: 1, result: procurementResult(domain) };
    default:
      throw ApplicationFailure.create({
        type: 'SOURCE_UNAVAILABLE',
        message: 'Registry returned 503',
        nonRetryable: true,
      });
  }
}

async function launch(domain: string): Promise<{ companyId: string; jobId: string }> {
  const company = await call(env, alice, 'POST', '/api/v1/companies', { body: { domain } });
  const companyId = company.body.company.id as string;
  const job = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/research-jobs`);
  expect(job.status).toBe(202);
  await relayOnce(env.relayDb, dispatcher, silent);
  return { companyId, jobId: job.body.job_id as string };
}

async function waitForStatus(jobId: string, accept: string[], timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await call(env, alice, 'GET', `/api/v1/research-jobs/${jobId}`);
    if (accept.includes(res.body.status)) return res.body;
    if (Date.now() > deadline) throw new Error(`job ${jobId} stuck in ${res.body.status}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  [temporal, env] = await Promise.all([
    new GenericContainer('temporalio/temporal:1.9.1')
      .withCommand(['server', 'start-dev', '--ip', '0.0.0.0', '--headless'])
      .withExposedPorts(7233)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
    startTestEnv({ TEMPORAL_TASK_QUEUE: CONTROL_QUEUE, RESEARCH_PYTHON_TASK_QUEUE: PYTHON_QUEUE }),
  ]);
  const address = `${temporal.getHost()}:${temporal.getMappedPort(7233)}`;
  connection = await Connection.connect({ address });
  await connection.ensureConnected();
  dispatcher = createTemporalDispatcher(new Client({ connection }), CONTROL_QUEUE);
  env.dispatcher.forward = dispatcher;

  const native = await NativeConnection.connect({ address });
  controlWorker = await Worker.create({
    connection: native,
    taskQueue: CONTROL_QUEUE,
    workflowsPath: fileURLToPath(new URL('../../src/temporal/workflows.ts', import.meta.url)),
    activities: createControlActivities({ db: env.db, storage: env.storage }),
  });
  pythonWorker = await Worker.create({
    connection: native,
    taskQueue: PYTHON_QUEUE,
    activities: { run_adapter: runAdapter },
  });
  running = Promise.all([controlWorker.run(), pythonWorker.run()]);

  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  const ws = await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice Co' } });
  alice.workspaceId = ws.body.id;
}, 300_000);

afterAll(async () => {
  releaseSlowAdapters();
  controlWorker?.shutdown();
  pythonWorker?.shutdown();
  await running;
  await connection?.close();
  await env?.close();
  await temporal?.stop();
});

describe('research workflow on a real Temporal server', () => {
  it('runs every source and finishes with partial success when one source fails', async () => {
    const { companyId, jobId } = await launch('acme.example');
    const job = await waitForStatus(jobId, TERMINAL);

    expect(job.status).toBe('partial_success');
    const bySource = Object.fromEntries(
      job.sources.map((s: { source_key: string }) => [s.source_key, s]),
    );
    expect(bySource.mock_web.status).toBe('succeeded');
    expect(bySource.mock_people.status).toBe('succeeded');
    expect(bySource.mock_registry).toMatchObject({
      status: 'failed',
      error_code: 'SOURCE_UNAVAILABLE',
    });

    const requests = adapterCalls.filter((c) => c.company?.domain === 'acme.example');
    expect(requests.map((r) => r.source_key).sort()).toEqual([
      'mock_careers',
      'mock_people',
      'mock_procurement',
      'mock_registry',
      'mock_web',
    ]);
    for (const r of requests) expect(r.budget.max_records).toBeGreaterThan(0);

    const people = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/people`);
    expect(people.body.data).toHaveLength(3);
    const map = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/org-map`);
    expect(map.status).toBe(200);
  });

  it('redelivery of the same outbox event does not start a second execution', async () => {
    const { jobId } = await launch('initech.example');
    await waitForStatus(jobId, TERMINAL);
    const { rows } = await env.owner.query(
      `SELECT payload FROM outbox_events WHERE event_type = 'research.company.requested'
       AND payload->'workflow_input'->>'jobId' = $1`,
      [jobId],
    );
    await dispatcher.start(rows[0].payload.workflow_input);
    const handle = new Client({ connection }).workflow.getHandle(researchWorkflowId(jobId));
    await handle.result();
    const description = await handle.describe();
    expect(description.status.name).toBe('COMPLETED');
    expect(adapterCalls.filter((c) => c.company?.domain === 'initech.example')).toHaveLength(5);
  });

  it('cancels a running job through the API and records the cancellation', async () => {
    const { jobId } = await launch('slow.example');
    await waitForStatus(jobId, ['running']);
    const cancel = await call(env, alice, 'POST', `/api/v1/research-jobs/${jobId}/cancel`);
    expect(cancel.status).toBe(202);

    const job = await waitForStatus(jobId, TERMINAL);
    expect(job.status).toBe('cancelled');
    releaseSlowAdapters();

    const audit = await call(env, alice, 'GET', `/api/v1/audit-events?entity_id=${jobId}`);
    const actions = audit.body.data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['research.cancel_requested', 'research.completed']),
    );
    const people = await env.owner.query(
      `SELECT count(*)::int AS n FROM person_company_links l JOIN workflow_jobs j ON j.company_id = l.company_id
       WHERE j.id = $1`,
      [jobId],
    );
    expect(people.rows[0].n).toBe(0);
  });
});
