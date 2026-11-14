import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

let env: TestEnv;
let alice: Actor;
let bob: Actor;
let companyId: string;

beforeAll(async () => {
  env = await startTestEnv();
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
  alice.workspaceId = (
    await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice Intel' } })
  ).body.id;
  bob.workspaceId = (
    await call(env, bob, 'POST', '/api/v1/workspaces', { body: { name: 'Bob Intel' } })
  ).body.id;
  companyId = (
    await call(env, alice, 'POST', '/api/v1/companies', {
      body: { domain: 'p14-intel.example', name: 'P14 Intel Co' },
    })
  ).body.company.id;
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('account intelligence', () => {
  it('generates a draft report with agent trace and no CRM write', async () => {
    const created = await call(
      env,
      alice,
      'POST',
      `/api/v1/companies/${companyId}/account-intelligence`,
    );
    expect(created.status).toBe(201);
    expect(created.body.orchestrator_version).toBe('account-intel/1.0.0');
    expect(created.body.note).toMatch(/Not written to CRM/i);
    expect(created.body.agent_trace.length).toBeGreaterThanOrEqual(4);
    expect(['draft_for_review', 'quarantined']).toContain(created.body.status);

    const list = await call(
      env,
      alice,
      'GET',
      `/api/v1/companies/${companyId}/account-intelligence`,
    );
    expect(list.status).toBe(200);
    expect(list.body.data[0].id).toBe(created.body.id);

    const reviewed = await call(
      env,
      alice,
      'PATCH',
      `/api/v1/account-intelligence/${created.body.id}`,
      {
        body: { status: 'accepted', review_note: 'Looks grounded' },
      },
    );
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.status).toBe('accepted');
    expect(reviewed.body.note).toMatch(/CRM unchanged/i);
  });

  it('blocks bob from alice company intel', async () => {
    expect(
      (await call(env, bob, 'POST', `/api/v1/companies/${companyId}/account-intelligence`)).status,
    ).toBe(404);
  });
});
