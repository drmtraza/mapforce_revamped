import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { persistSourceResult } from '../../src/modules/research/persist.ts';
import { peopleResult, webResult } from '../support/adapter-fixtures.ts';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

const DOMAIN = 'acme.example';

let env: TestEnv;
let alice: Actor;
let bob: Actor;
let companyId: string;
let icpId: string;
let listId: string;

beforeAll(async () => {
  env = await startTestEnv();
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
  const ws = await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice P5' } });
  alice.workspaceId = ws.body.id;
  const bobWs = await call(env, bob, 'POST', '/api/v1/workspaces', { body: { name: 'Bob P5' } });
  bob.workspaceId = bobWs.body.id;

  const icp = await call(env, alice, 'POST', '/api/v1/icp-profiles', {
    body: {
      name: 'Software GB',
      definition: {
        industries: ['Software'],
        countries: ['GB'],
        target_personas: ['technical_evaluator'],
        signals: ['hiring'],
      },
    },
  });
  icpId = icp.body.id;

  const company = await call(env, alice, 'POST', '/api/v1/companies', {
    body: { domain: DOMAIN, name: 'Acme Example' },
  });
  companyId = company.body.company.id;
  await call(env, alice, 'POST', '/api/v1/companies', {
    body: { domain: 'safe.example', name: '=HYPERLINK("http://evil")' },
  });
  const job = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/research-jobs`);
  const common = {
    tenantId: alice.workspaceId!,
    jobId: job.body.job_id as string,
    companyId,
    correlationId: 'p5',
    attempts: 1,
  };
  await persistSourceResult(env.db, env.storage, {
    ...common,
    sourceKey: 'mock_web',
    result: webResult(DOMAIN),
  });
  await persistSourceResult(env.db, env.storage, {
    ...common,
    sourceKey: 'mock_people',
    result: peopleResult(DOMAIN),
  });
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('BD workspace', () => {
  it('scores a company with factor explanations', async () => {
    const run = await call(env, alice, 'POST', `/api/v1/icp-profiles/${icpId}/score-runs`, {
      body: { company_ids: [companyId] },
    });
    expect(run.status).toBe(200);
    expect(run.body.data[0].total_score).toBeGreaterThan(0);
    expect(run.body.data[0].eligible).toBe(true);
    expect(run.body.data[0].factors).toHaveLength(5);

    const latest = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/score`);
    expect(latest.body.score.company_id).toBe(companyId);
  });

  it('assigns pipeline stage and records a task and note', async () => {
    const assigned = await call(env, alice, 'PATCH', `/api/v1/accounts/${companyId}`, {
      body: { stage: 'qualified', priority: 'high' },
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.stage).toBe('qualified');
    const accounts = await call(env, alice, 'GET', '/api/v1/accounts');
    expect(accounts.body.data.some((a: { company_id: string }) => a.company_id === companyId)).toBe(
      true,
    );
    const task = await call(env, alice, 'POST', '/api/v1/tasks', {
      body: { company_id: companyId, title: 'Review dossier' },
    });
    expect(task.status).toBe(201);
    const note = await call(env, alice, 'POST', '/api/v1/notes', {
      body: { company_id: companyId, body: 'Human-reviewed only.' },
    });
    expect(note.status).toBe(201);
  });

  it('blocks suppressed companies on lists and omits them from formula-safe export', async () => {
    const list = await call(env, alice, 'POST', '/api/v1/lists', {
      body: { name: 'Outbound', kind: 'companies' },
    });
    listId = list.body.id;
    const added = await call(env, alice, 'POST', `/api/v1/lists/${listId}/items`, {
      body: { entity_type: 'company', entity_id: companyId },
    });
    expect(added.status).toBe(201);

    await call(env, alice, 'POST', '/api/v1/suppressions', {
      body: { subject_type: 'domain', value: DOMAIN, reason: 'opt out' },
    });
    const blocked = await call(env, alice, 'POST', `/api/v1/lists/${listId}/items`, {
      body: { entity_type: 'company', entity_id: companyId },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SUPPRESSED');

    const scored = await call(env, alice, 'POST', `/api/v1/icp-profiles/${icpId}/score-runs`, {
      body: { company_ids: [companyId] },
    });
    expect(scored.body.data[0].eligible).toBe(false);
    expect(scored.body.data[0].total_score).toBe(0);

    const exported = await call(env, alice, 'POST', '/api/v1/exports', {
      body: { scope: 'companies' },
    });
    expect(exported.status).toBe(200);
    expect(exported.body.omitted_suppressed).toBeGreaterThan(0);
    expect(exported.body.csv).not.toMatch(DOMAIN);
    expect(exported.body.csv).toMatch(/"'=/);
  });

  it('exposes usage and hides another tenant (404)', async () => {
    const usage = await call(env, alice, 'GET', '/api/v1/usage');
    expect(usage.status).toBe(200);
    expect(usage.body.jobs.company_research).toBeGreaterThan(0);
    expect(usage.body.note).toMatch(/Billing/);
    expect((await call(env, bob, 'GET', `/api/v1/companies/${companyId}/score`)).status).toBe(404);
    expect((await call(env, bob, 'GET', `/api/v1/lists/${listId}`)).status).toBe(404);
    expect(
      (
        await call(env, bob, 'POST', '/api/v1/exports', {
          body: { scope: 'list', list_id: listId },
        })
      ).status,
    ).toBe(404);
  });
});
