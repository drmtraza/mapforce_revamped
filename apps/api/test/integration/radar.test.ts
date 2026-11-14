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
  const ws = await call(env, alice, 'POST', '/api/v1/workspaces', {
    body: { name: 'Alice Radar' },
  });
  alice.workspaceId = ws.body.id;
  const bobWs = await call(env, bob, 'POST', '/api/v1/workspaces', {
    body: { name: 'Bob Radar' },
  });
  bob.workspaceId = bobWs.body.id;

  const company = await call(env, alice, 'POST', '/api/v1/companies', {
    body: { domain: 'p13-radar.example', name: 'P13 Radar Co' },
  });
  companyId = company.body.company.id;

  await env.owner.query(
    `INSERT INTO intent_signals (
       tenant_id, company_id, signal_type, title, summary, implies_budget,
       claim_type, confidence, observed_at, source_key
     ) VALUES (
       (SELECT tenant_id FROM companies WHERE id = $1),
       $1, 'procurement', 'RFI for managed SOC',
       'Public RFI for security monitoring', false, 'source_fact', 0.9,
       now() - interval '2 days', 'mock_procurement'
     )`,
    [companyId],
  );
  await env.owner.query(
    `INSERT INTO intent_signals (
       tenant_id, company_id, signal_type, title, summary, implies_budget,
       claim_type, confidence, observed_at, source_key
     ) VALUES (
       (SELECT tenant_id FROM companies WHERE id = $1),
       $1, 'news', 'Old press release',
       'Stale announcement', false, 'model_inference', 0.5,
       now() - interval '90 days', 'mock_web'
     )`,
    [companyId],
  );
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('opportunity radar', () => {
  it('refreshes feed with claim labels and decayed announcements', async () => {
    const refresh = await call(env, alice, 'POST', '/api/v1/opportunity-radar/refresh');
    expect(refresh.status).toBe(200);
    expect(refresh.body.from_signals).toBeGreaterThanOrEqual(2);

    const feed = await call(env, alice, 'GET', '/api/v1/opportunity-radar?min_freshness=0');
    expect(feed.status).toBe(200);
    expect(feed.body.note).toMatch(/decay/i);
    const fresh = feed.body.data.find((o: { title: string }) => o.title.includes('managed SOC'));
    const stale = feed.body.data.find((o: { title: string }) => o.title.includes('Old press'));
    expect(fresh.claim_label).toBe('verified_source');
    expect(stale.claim_label).toBe('model_inference');
    expect(stale.freshness_score).toBeLessThan(fresh.freshness_score);
  });

  it('runs mission with pause and budget controls', async () => {
    const created = await call(env, alice, 'POST', '/api/v1/radar-missions', {
      body: { name: 'P13 scan', interval_hours: 24, daily_run_budget: 1 },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const run = await call(env, alice, 'POST', `/api/v1/radar-missions/${id}/run`);
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('succeeded');
    expect(run.body.opportunities_upserted).toBeGreaterThan(0);

    const budget = await call(env, alice, 'POST', `/api/v1/radar-missions/${id}/run`);
    expect(budget.body.status).toBe('skipped_budget');

    await call(env, alice, 'PATCH', `/api/v1/radar-missions/${id}`, {
      body: { status: 'paused' },
    });
    // Reset budget counter via owner so pause path is exercised.
    await env.owner.query(`UPDATE radar_missions SET runs_today = 0 WHERE id = $1`, [id]);
    const paused = await call(env, alice, 'POST', `/api/v1/radar-missions/${id}/run`);
    expect(paused.body.status).toBe('skipped_paused');
  });

  it('hides alice radar from bob', async () => {
    const feed = await call(env, bob, 'GET', '/api/v1/opportunity-radar');
    expect(feed.status).toBe(200);
    expect(feed.body.data).toEqual([]);
  });
});
