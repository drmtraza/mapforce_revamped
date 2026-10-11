import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { persistSourceResult } from '../../src/modules/research/persist.ts';
import { hashContactValue } from '../../src/modules/contacts/crypto.ts';
import { contactsResult, peopleResult, webResult } from '../support/adapter-fixtures.ts';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

const DOMAIN = 'acme.example';
const OTHER = 'globex.example';

let env: TestEnv;
let alice: Actor;
let bob: Actor;
let companyId: string;
let otherCompanyId: string;
let personId: string;
let otherPersonId: string;

beforeAll(async () => {
  env = await startTestEnv();
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
  const ws = await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice P3' } });
  alice.workspaceId = ws.body.id;
  const bobWs = await call(env, bob, 'POST', '/api/v1/workspaces', { body: { name: 'Bob P3' } });
  bob.workspaceId = bobWs.body.id;

  const company = await call(env, alice, 'POST', '/api/v1/companies', { body: { domain: DOMAIN } });
  companyId = company.body.company.id;
  const other = await call(env, alice, 'POST', '/api/v1/companies', { body: { domain: OTHER } });
  otherCompanyId = other.body.company.id;

  const jobA = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/research-jobs`);
  const jobB = await call(env, alice, 'POST', `/api/v1/companies/${otherCompanyId}/research-jobs`);
  const commonA = {
    tenantId: alice.workspaceId!,
    jobId: jobA.body.job_id as string,
    companyId,
    correlationId: 'p3-a',
    attempts: 1,
  };
  const commonB = {
    tenantId: alice.workspaceId!,
    jobId: jobB.body.job_id as string,
    companyId: otherCompanyId,
    correlationId: 'p3-b',
    attempts: 1,
  };
  await persistSourceResult(env.db, env.storage, {
    ...commonA,
    sourceKey: 'mock_web',
    result: webResult(DOMAIN),
  });
  await persistSourceResult(env.db, env.storage, {
    ...commonA,
    sourceKey: 'mock_people',
    result: peopleResult(DOMAIN),
  });
  await persistSourceResult(env.db, env.storage, {
    ...commonB,
    sourceKey: 'mock_web',
    result: webResult(OTHER),
  });
  const sameName = peopleResult(OTHER);
  sameName.people = [
    {
      ...sameName.people[0]!,
      full_name: 'Avery Example',
      title: 'CTO',
    },
  ];
  sameName.relationships = [];
  await persistSourceResult(env.db, env.storage, {
    ...commonB,
    sourceKey: 'mock_people',
    result: sameName,
  });

  const people = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/people`);
  personId = people.body.data.find(
    (p: { canonical_name: string }) => p.canonical_name === 'Avery Example',
  ).id;
  const otherPeople = await call(env, alice, 'GET', `/api/v1/companies/${otherCompanyId}/people`);
  otherPersonId = otherPeople.body.data[0].id;
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('role history, match, merge and split', () => {
  it('keeps prior titles as past roles instead of overwriting', async () => {
    const job = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/research-jobs`);
    const changed = peopleResult(DOMAIN);
    changed.people = [
      { ...changed.people[0]!, title: 'SVP Engineering', seniority: 'executive' },
      ...changed.people.slice(1),
    ];
    await persistSourceResult(env.db, env.storage, {
      tenantId: alice.workspaceId!,
      jobId: job.body.job_id,
      companyId,
      sourceKey: 'mock_people',
      correlationId: 'p3-role',
      attempts: 1,
      result: changed,
    });
    const detail = await call(env, alice, 'GET', `/api/v1/people/${personId}`);
    expect(detail.status).toBe(200);
    const titles = detail.body.roles.map(
      (r: { title: string; status: string }) => `${r.status}:${r.title}`,
    );
    expect(titles).toEqual(
      expect.arrayContaining(['past:VP Engineering', 'current:SVP Engineering']),
    );
  });

  it('proposes a match for the same name at another company and supports merge/split', async () => {
    const matches = await call(env, alice, 'GET', '/api/v1/people/match-candidates');
    const match = matches.body.data.find(
      (m: { person_a_id: string; person_b_id: string }) =>
        [m.person_a_id, m.person_b_id].includes(personId) &&
        [m.person_a_id, m.person_b_id].includes(otherPersonId),
    );
    expect(match).toBeTruthy();
    expect(match.rationale).toMatch(/normalized name/i);

    const merged = await call(
      env,
      alice,
      'POST',
      `/api/v1/people/match-candidates/${match.id}/accept`,
      {
        body: { survivor_person_id: personId },
      },
    );
    expect(merged.status).toBe(200);
    expect(merged.body.survivor_id).toBe(personId);

    const hidden = await call(env, alice, 'GET', `/api/v1/people/${otherPersonId}`);
    expect(hidden.status).toBe(404);

    const survivor = await call(env, alice, 'GET', `/api/v1/people/${personId}`);
    expect(survivor.body.aliases).toContain('Avery Example');
    expect(survivor.body.merges).toHaveLength(1);

    const split = await call(
      env,
      alice,
      'POST',
      `/api/v1/people/merges/${survivor.body.merges[0].id}/split`,
    );
    expect(split.status).toBe(200);
    const restored = await call(env, alice, 'GET', `/api/v1/people/${otherPersonId}`);
    expect(restored.status).toBe(200);
  });
});

describe('contact enrichment and suppression', () => {
  it('never labels a pattern guess as verified and hides the raw value', async () => {
    const enrich = await call(env, alice, 'POST', `/api/v1/people/${personId}/enrich-jobs`);
    expect(enrich.status).toBe(202);
    const created = await env.owner.query(
      `SELECT person_id, job_type FROM workflow_jobs WHERE id = $1`,
      [enrich.body.job_id],
    );
    expect(created.rows[0]).toMatchObject({ person_id: personId, job_type: 'person_enrichment' });
    await persistSourceResult(env.db, env.storage, {
      tenantId: alice.workspaceId!,
      jobId: enrich.body.job_id,
      companyId,
      sourceKey: 'mock_contacts',
      correlationId: 'p3-enrich',
      attempts: 1,
      result: contactsResult(DOMAIN, 'avery.example@acme.example'),
    });

    const detail = await call(env, alice, 'GET', `/api/v1/people/${personId}`);
    expect(detail.body.contact_points).toHaveLength(1);
    const contact = detail.body.contact_points[0];
    expect(contact.status).toBe('unverified');
    expect(contact.verification_method).toBe('pattern');
    expect(contact.verified_at).toBeNull();
    expect(contact.display_hint).toBe('a***@acme.example');
    expect(JSON.stringify(detail.body)).not.toContain('avery.example@acme.example');
    expect(contact.status).not.toBe('provider_verified');
  });

  it('rejects a guessed address that claims provider_verified', async () => {
    const job = await call(env, alice, 'POST', `/api/v1/people/${personId}/enrich-jobs`);
    const forged = contactsResult(DOMAIN, 'jordan.sample@acme.example');
    forged.contact_points![0]!.status = 'provider_verified';
    forged.contact_points![0]!.verification_method = 'pattern';
    forged.contact_points![0]!.verified_at = '2026-10-01T00:00:00Z';
    const outcome = await persistSourceResult(env.db, env.storage, {
      tenantId: alice.workspaceId!,
      jobId: job.body.job_id,
      companyId,
      sourceKey: 'mock_contacts',
      correlationId: 'p3-forged',
      attempts: 1,
      result: forged,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('ADAPTER_PAYLOAD_INVALID');
  });

  it('blocks enrichment when the address is suppressed', async () => {
    const created = await call(env, alice, 'POST', '/api/v1/suppressions', {
      body: { subject_type: 'email', value: 'avery.example@acme.example', reason: 'opt-out' },
    });
    expect(created.status).toBe(201);
    expect(created.body.display_hint).toBe('a***@acme.example');
    expect(JSON.stringify(created.body)).not.toContain('avery.example@acme.example');

    const job = await call(env, alice, 'POST', `/api/v1/people/${personId}/enrich-jobs`);
    await persistSourceResult(env.db, env.storage, {
      tenantId: alice.workspaceId!,
      jobId: job.body.job_id,
      companyId,
      sourceKey: 'mock_contacts',
      correlationId: 'p3-sup',
      attempts: 1,
      result: contactsResult(DOMAIN, 'avery.example@acme.example'),
    });
    const { rows } = await env.owner.query(
      `SELECT count(*)::int AS n FROM contact_points
        WHERE tenant_id = $1 AND normalized_value_hash = $2 AND status <> 'suppressed'`,
      [alice.workspaceId, hashContactValue('email', 'avery.example@acme.example')],
    );
    expect(rows[0].n).toBe(0);
  });

  it('keeps licensed_contacts globally disabled', async () => {
    const sources = await call(env, alice, 'GET', '/api/v1/sources');
    const licensed = sources.body.data.find((s: { id: string }) => s.id === 'licensed_contacts');
    expect(licensed.globally_enabled).toBe(false);
    expect(licensed.available).toBe(false);
    expect(licensed.unavailable_reason).toMatch(/platform owner/i);
  });

  it('does not let tenant B read tenant A people, contacts or suppressions', async () => {
    const person = await call(env, bob, 'GET', `/api/v1/people/${personId}`, {
      workspaceId: bob.workspaceId,
    });
    expect(person.status).toBe(404);
    const matches = await call(env, bob, 'GET', '/api/v1/people/match-candidates', {
      workspaceId: bob.workspaceId,
    });
    expect(matches.body.data).toEqual([]);
    const suppressions = await call(env, bob, 'GET', '/api/v1/suppressions', {
      workspaceId: bob.workspaceId,
    });
    expect(suppressions.body.data).toEqual([]);
  });
});

describe('company signals', () => {
  it('lists hiring and procurement signals with evidence and no budget claim', async () => {
    const { persistSourceResult: persist } = await import('../../src/modules/research/persist.ts');
    const { careersResult, procurementResult } = await import('../support/adapter-fixtures.ts');
    const job = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/research-jobs`);
    await persist(env.db, env.storage, {
      tenantId: alice.workspaceId!,
      jobId: job.body.job_id,
      companyId,
      sourceKey: 'mock_careers',
      correlationId: 'p3-sig',
      attempts: 1,
      result: careersResult(DOMAIN),
    });
    await persist(env.db, env.storage, {
      tenantId: alice.workspaceId!,
      jobId: job.body.job_id,
      companyId,
      sourceKey: 'mock_procurement',
      correlationId: 'p3-sig',
      attempts: 1,
      result: procurementResult(DOMAIN),
    });
    const signals = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/signals`);
    expect(signals.status).toBe(200);
    expect(signals.body.data.some((s: { signal_type: string }) => s.signal_type === 'hiring')).toBe(
      true,
    );
    for (const s of signals.body.data) {
      expect(s.implies_budget).toBe(false);
      expect(s.evidence.length).toBeGreaterThan(0);
    }
    const bobSignals = await call(env, bob, 'GET', `/api/v1/companies/${companyId}/signals`, {
      workspaceId: bob.workspaceId,
    });
    expect(bobSignals.status).toBe(404);
  });
});
