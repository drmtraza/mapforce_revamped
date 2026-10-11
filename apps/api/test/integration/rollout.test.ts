import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

let env: TestEnv;
let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  env = await startTestEnv({
    DEFAULT_TENANT_PLAN: 'beta',
    MAX_BETA_TENANTS: '2',
    SYNTHETIC_PROBE_TOKEN: 'synthetic-probe-token-16',
  });
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
  const ws = await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice Beta' } });
  expect(ws.status).toBe(201);
  alice.workspaceId = ws.body.id;
  const bobWs = await call(env, bob, 'POST', '/api/v1/workspaces', { body: { name: 'Bob Beta' } });
  expect(bobWs.status).toBe(201);
  bob.workspaceId = bobWs.body.id;
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('controlled rollout', () => {
  it('assigns beta plan ceilings and lists feature flags', async () => {
    const rollout = await call(env, alice, 'GET', '/api/v1/rollout');
    expect(rollout.status).toBe(200);
    expect(rollout.body.plan_id).toBe('beta');
    expect(rollout.body.effective_limits.research).toBeLessThanOrEqual(40);
    expect(rollout.body.flags.some((f: { key: string }) => f.key === 'beta_feedback')).toBe(true);
  });

  it('rejects quota ramp above the plan ceiling', async () => {
    const ramp = await call(env, alice, 'POST', '/api/v1/workspace-budget/ramp', {
      body: {
        field: 'daily_research_job_limit',
        next_value: 1000,
        rationale: 'Would exceed beta packaging.',
      },
    });
    expect(ramp.status).toBe(429);
    expect(ramp.body.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('ramps within the ceiling and records feedback + incident triage', async () => {
    const ramp = await call(env, alice, 'POST', '/api/v1/workspace-budget/ramp', {
      body: {
        field: 'daily_export_limit',
        next_value: 5,
        rationale: 'Observed mock export load is healthy.',
      },
    });
    expect(ramp.status).toBe(200);
    expect(ramp.body.next_value).toBe(5);
    expect(ramp.body.plan_ceiling).toBe(8);

    const feedback = await call(env, alice, 'POST', '/api/v1/feedback', {
      body: { category: 'data_quality', body: 'Persona labels look right on the mock map.' },
    });
    expect(feedback.status).toBe(201);

    const incident = await call(env, alice, 'POST', '/api/v1/ops/incidents', {
      body: { severity: 'P3', summary: 'Cosmetic badge copy in pipeline board.' },
    });
    expect(incident.status).toBe(201);

    const quality = await call(env, alice, 'GET', '/api/v1/ops/data-quality');
    expect(quality.status).toBe(200);
    expect(quality.body.open_feedback).toBeGreaterThan(0);
    expect(quality.body.open_incidents).toBeGreaterThan(0);
    expect(quality.body.note).toMatch(/Contact values/);
  });

  it('runs synthetic checks and hides probe without token', async () => {
    const check = await call(env, alice, 'POST', '/api/v1/ops/synthetic-check');
    expect(check.status).toBe(200);
    expect(check.body.ok).toBe(true);

    const denied = await env.app.inject({ method: 'GET', url: '/synthetic/probe' });
    expect(denied.statusCode).toBe(404);

    const probe = await env.app.inject({
      method: 'GET',
      url: '/synthetic/probe',
      headers: { 'x-synthetic-token': 'synthetic-probe-token-16' },
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().ok).toBe(true);
  });

  it('enforces the beta seat cap and isolates bob from alice feedback', async () => {
    const thirdUser = await signIn(env, 'carol', 'carol@tenant-c.test');
    const third = await call(env, thirdUser, 'POST', '/api/v1/workspaces', {
      body: { name: 'Overflow Beta' },
    });
    expect(third.status).toBe(429);

    const list = await call(env, bob, 'GET', '/api/v1/feedback');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
  });
});
