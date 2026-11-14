import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

let env: TestEnv;
let alice: Actor;
let bob: Actor;
let companyId: string;
let offeringId: string;

beforeAll(async () => {
  env = await startTestEnv();
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
  const ws = await call(env, alice, 'POST', '/api/v1/workspaces', {
    body: { name: 'Alice Catalogue' },
  });
  alice.workspaceId = ws.body.id;
  const bobWs = await call(env, bob, 'POST', '/api/v1/workspaces', {
    body: { name: 'Bob Catalogue' },
  });
  bob.workspaceId = bobWs.body.id;

  const company = await call(env, alice, 'POST', '/api/v1/companies', {
    body: { domain: 'p12-bank.example', name: 'P12 Bank' },
  });
  companyId = company.body.company.id;
  await env.owner.query(
    `UPDATE companies SET industry = 'financial_services', country_code = 'SA',
     employee_band = '201-500' WHERE id = $1`,
    [companyId],
  );

  const offering = await call(env, alice, 'POST', '/api/v1/product-offerings', {
    body: {
      name: 'Managed SOC',
      category: 'cybersecurity',
      description: '24x7 detection and response.',
      business_problem: 'Security monitoring for cloud infrastructure',
      target_industries: ['financial_services'],
      target_countries: ['SA'],
      employee_bands: ['201-500'],
      target_personas: ['economic_buyer'],
      pricing_model: 'subscription',
      price_range_note: 'Confirm with approved price list',
      status: 'active',
    },
  });
  expect(offering.status).toBe(201);
  offeringId = offering.body.id;
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('product catalogue and matching', () => {
  it('lists offerings and attaches documents', async () => {
    const list = await call(env, alice, 'GET', '/api/v1/product-offerings');
    expect(list.status).toBe(200);
    expect(list.body.data.some((o: { id: string }) => o.id === offeringId)).toBe(true);

    const doc = await call(
      env,
      alice,
      'POST',
      `/api/v1/product-offerings/${offeringId}/documents`,
      {
        body: {
          title: 'SOC one-pager',
          doc_kind: 'brochure',
          source_uri: 'https://docs.example.invalid/soc.pdf',
        },
      },
    );
    expect(doc.status).toBe(201);
  });

  it('runs product match distinct from ICP score language', async () => {
    const match = await call(
      env,
      alice,
      'POST',
      `/api/v1/companies/${companyId}/opportunity-matches`,
    );
    expect(match.status).toBe(201);
    expect(match.body.matching_version).toBe('product-match/1.0.0');
    expect(match.body.account_score_note).toMatch(/not ICP account scores/i);
    expect(match.body.data[0].offering_id).toBe(offeringId);
    expect(match.body.data[0].match_score).toBeGreaterThan(0);
    expect(match.body.data[0].note).toMatch(/Not buying intent/);

    const latest = await call(
      env,
      alice,
      'GET',
      `/api/v1/companies/${companyId}/opportunity-matches`,
    );
    expect(latest.status).toBe(200);
    expect(latest.body.run_id).toBe(match.body.run_id);
  });

  it('hides alice catalogue from bob workspace', async () => {
    expect(
      (await call(env, bob, 'GET', `/api/v1/product-offerings/${offeringId}/documents`)).status,
    ).toBe(404);
    expect(
      (
        await call(env, bob, 'POST', `/api/v1/companies/${companyId}/opportunity-matches`, {
          workspaceId: alice.workspaceId,
        })
      ).status,
    ).toBe(404);
  });
});
