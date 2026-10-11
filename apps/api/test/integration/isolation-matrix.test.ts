import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

let env: TestEnv;
let alice: Actor;
let bob: Actor;
let companyId: string;
let personId: string;
let incidentId: string;

beforeAll(async () => {
  env = await startTestEnv();
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
  const ws = await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice P8' } });
  alice.workspaceId = ws.body.id;
  const bobWs = await call(env, bob, 'POST', '/api/v1/workspaces', { body: { name: 'Bob P8' } });
  bob.workspaceId = bobWs.body.id;
  const company = await call(env, alice, 'POST', '/api/v1/companies', {
    body: { domain: 'p8-iso.example', name: 'P8 Iso Co' },
  });
  companyId = company.body.company.id;
  await call(env, alice, 'PATCH', `/api/v1/accounts/${companyId}`, {
    body: { stage: 'qualified', priority: 'normal' },
  });
  const person = await env.owner.query<{ id: string }>(
    `INSERT INTO people (tenant_id, canonical_name, normalized_name, review_status)
     VALUES ($1, 'Iso Person', 'iso person', 'unreviewed') RETURNING id`,
    [alice.workspaceId],
  );
  personId = person.rows[0]!.id;
  await env.owner.query(
    `INSERT INTO person_company_links (tenant_id, person_id, company_id, relationship_status, confidence)
     VALUES ($1, $2, $3, 'current', 0.5)`,
    [alice.workspaceId, personId, companyId],
  );
  const incident = await call(env, alice, 'POST', '/api/v1/ops/incidents', {
    body: { severity: 'P3', summary: 'Isolation matrix fixture' },
  });
  incidentId = incident.body.id;
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('cross-tenant IDOR matrix', () => {
  it('returns 404 for bob using alice resource ids in bob workspace', async () => {
    const cases: Array<{ method: 'GET' | 'POST' | 'PATCH'; url: string; body?: unknown }> = [
      { method: 'PATCH', url: `/api/v1/accounts/${companyId}`, body: { stage: 'closed_won' } },
      { method: 'POST', url: `/api/v1/people/${personId}/enrich-jobs` },
      {
        method: 'POST',
        url: '/api/v1/tasks',
        body: { company_id: companyId, title: 'Hijack' },
      },
      {
        method: 'POST',
        url: '/api/v1/notes',
        body: { company_id: companyId, body: 'Should not land' },
      },
      { method: 'PATCH', url: `/api/v1/ops/incidents/${incidentId}`, body: { status: 'resolved' } },
      { method: 'GET', url: `/api/v1/people/${personId}` },
      { method: 'GET', url: `/api/v1/companies/${companyId}` },
    ];
    for (const c of cases) {
      const res = await call(env, bob, c.method, c.url, { body: c.body });
      expect(res.status, `${c.method} ${c.url}`).toBe(404);
    }
  });

  it('returns 404 when bob sends alice workspace header', async () => {
    const cases: Array<{ method: 'GET' | 'POST' | 'PATCH'; url: string; body?: unknown }> = [
      {
        method: 'POST',
        url: '/api/v1/workspace-budget/ramp',
        body: {
          field: 'daily_export_limit',
          next_value: 1,
          rationale: 'Cross-tenant attempt',
        },
      },
      { method: 'PATCH', url: '/api/v1/feature-flags/beta_feedback', body: { enabled: false } },
      { method: 'GET', url: '/api/v1/rollout' },
    ];
    for (const c of cases) {
      const res = await call(env, bob, c.method, c.url, {
        body: c.body,
        workspaceId: alice.workspaceId,
      });
      expect(res.status, `${c.method} ${c.url}`).toBe(404);
    }
  });
});
