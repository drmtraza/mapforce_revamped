import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

let env: TestEnv;
let alice: Actor;
let bob: Actor;
let companyId: string;
let personId: string;
let evidenceId: string;

beforeAll(async () => {
  env = await startTestEnv();
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
  alice.workspaceId = (
    await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice Committee' } })
  ).body.id;
  bob.workspaceId = (
    await call(env, bob, 'POST', '/api/v1/workspaces', { body: { name: 'Bob Committee' } })
  ).body.id;
  companyId = (
    await call(env, alice, 'POST', '/api/v1/companies', {
      body: { domain: 'p15-committee.example', name: 'P15 Co' },
    })
  ).body.company.id;

  const tenant = await env.owner.query(`SELECT tenant_id FROM companies WHERE id = $1`, [
    companyId,
  ]);
  const tenantId = tenant.rows[0].tenant_id as string;
  const person = await env.owner.query(
    `INSERT INTO people (tenant_id, canonical_name, normalized_name, review_status)
     VALUES ($1, 'Pat Buyer', 'pat buyer', 'accepted')
     RETURNING id`,
    [tenantId],
  );
  personId = person.rows[0].id as string;
  await env.owner.query(
    `INSERT INTO person_company_links (tenant_id, person_id, company_id, relationship_status, confidence)
     VALUES ($1, $2, $3, 'current', 0.9)`,
    [tenantId, personId, companyId],
  );
  const evidence = await env.owner.query(
    `INSERT INTO evidence_records (
       tenant_id, company_id, source_registry_id, source_url, fetched_at,
       content_hash, content_type, excerpt, license_metadata
     ) VALUES (
       $1, $2, 'mock_web', 'https://p15-committee.example/budget', now(),
       'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       'text/plain', 'Budget authority stated', '{}'::jsonb
     ) RETURNING id`,
    [tenantId, companyId],
  );
  evidenceId = evidence.rows[0].id as string;
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('buying committee and account plans', () => {
  it('rejects budget_owner without evidence and accepts grounded classification', async () => {
    const bad = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/buying-committee`, {
      body: {
        person_id: personId,
        committee_role: 'budget_owner',
        claim_type: 'user_assertion',
        rationale: 'Seems like budget owner',
        evidence_ids: [],
      },
    });
    expect(bad.status).toBe(400);

    const champion = await call(
      env,
      alice,
      'POST',
      `/api/v1/companies/${companyId}/buying-committee`,
      {
        body: {
          person_id: personId,
          committee_role: 'champion',
          claim_type: 'user_assertion',
          rationale: 'Engaged on discovery call',
          evidence_ids: [],
        },
      },
    );
    expect(champion.status).toBe(201);
    expect(champion.body.coverage.coverage_score).toBeGreaterThan(0);

    const owner = await call(
      env,
      alice,
      'POST',
      `/api/v1/companies/${companyId}/buying-committee`,
      {
        body: {
          person_id: personId,
          committee_role: 'budget_owner',
          claim_type: 'source_fact',
          rationale: 'Named in procurement notice',
          evidence_ids: [evidenceId],
        },
      },
    );
    expect(owner.status).toBe(201);
    expect(owner.body.member.evidence_ids).toContain(evidenceId);
  });

  it('creates versioned account plan with coverage and manager assign', async () => {
    const plan = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/account-plans`, {
      body: {
        title: 'P15 pursuit',
        situation: 'Committee partially mapped.',
        objective: 'Qualify fit for managed SOC.',
        strategy: 'Engage champion; request evidence for economic buyer.',
        next_steps: 'Schedule discovery; do not invent reporting lines.',
        assigned_manager_user_id: alice.userId,
        activate: true,
      },
    });
    expect(plan.status).toBe(201);
    expect(plan.body.version).toBe(1);
    expect(plan.body.status).toBe('active');
    expect(plan.body.reporting_note).toMatch(/does not invent/i);
    expect(plan.body.assigned_manager_user_id).toBe(alice.userId);

    const list = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/account-plans`);
    expect(list.body.data[0].id).toBe(plan.body.id);
  });

  it('hides alice committee from bob', async () => {
    expect(
      (await call(env, bob, 'GET', `/api/v1/companies/${companyId}/buying-committee`)).status,
    ).toBe(404);
  });
});
