import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateOrgMapV2 } from '@mapforce/contracts';
import { relayOnce } from '../../src/modules/outbox/relay.ts';
import { createControlActivities } from '../../src/temporal/activities.ts';
import { peopleResult, registryFailure, webResult } from '../support/adapter-fixtures.ts';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

const DOMAIN = 'acme.example';
const silent = { warn: () => undefined, error: () => undefined };

let env: TestEnv;
let alice: Actor;
let bob: Actor;
let companyId: string;
let jobId: string;
let personId: string;
let evidenceId: string;

async function runMockWorkflow(tenantId: string, job: string, company: string) {
  const acts = createControlActivities({ db: env.db, storage: env.storage });
  const ref = { tenantId, jobId: job, correlationId: 'test-correlation' };
  const start = await acts.markJobRunning(ref);
  expect(start.proceed).toBe(true);
  const common = { ...ref, companyId: company, attempts: 1 };
  const outcomes = [
    await acts.persistSourceResult({ ...common, sourceKey: 'mock_web', result: webResult(DOMAIN) }),
    await acts.persistSourceResult({
      ...common,
      sourceKey: 'mock_registry',
      result: registryFailure(),
    }),
    await acts.persistSourceResult({
      ...common,
      sourceKey: 'mock_people',
      result: peopleResult(DOMAIN),
    }),
  ];
  return acts.finalizeJob({ ...ref, outcomes, cancelled: false });
}

beforeAll(async () => {
  // Alice creates two jobs before the quota test; the third must be refused.
  env = await startTestEnv({ TENANT_DAILY_RESEARCH_JOB_LIMIT: '2' });
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('API contract basics', () => {
  it('requires authentication and uses the standard error shape', async () => {
    const res = await call(env, null, 'GET', '/api/v1/workspaces');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(res.body.error.correlation_id).toBe(res.headers['x-correlation-id']);
  });

  it('rejects state-changing requests without the CSRF header', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie: alice.cookie },
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_REJECTED');
  });

  it('propagates a valid caller correlation id', async () => {
    const res = await call(env, alice, 'GET', '/api/v1/auth/me', {
      headers: { 'x-correlation-id': 'trace-abc-123' },
    });
    expect(res.headers['x-correlation-id']).toBe('trace-abc-123');
  });

  it('publishes an OpenAPI document', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain('/api/v1/companies/{id}/research-jobs');
  });
});

describe('first milestone journey', () => {
  it('creates workspaces and makes the creator owner', async () => {
    const a = await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice Co' } });
    expect(a.status).toBe(201);
    expect(a.body.role).toBe('owner');
    alice.workspaceId = a.body.id;

    const b = await call(env, bob, 'POST', '/api/v1/workspaces', { body: { name: 'Bob Co' } });
    bob.workspaceId = b.body.id;

    const list = await call(env, alice, 'GET', '/api/v1/workspaces');
    expect(list.body.data.map((w: { id: string }) => w.id)).toEqual([alice.workspaceId]);
  });

  it('defines and versions an ICP with optimistic concurrency', async () => {
    const created = await call(env, alice, 'POST', '/api/v1/icp-profiles', {
      body: {
        name: 'UK software',
        definition: {
          industries: ['Software'],
          countries: ['GB'],
          target_personas: ['economic_buyer'],
        },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(1);

    const updated = await call(env, alice, 'PATCH', `/api/v1/icp-profiles/${created.body.id}`, {
      body: {
        expected_version: 1,
        definition: { industries: ['Software', 'Fintech'], countries: ['GB', 'US'] },
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);

    const stale = await call(env, alice, 'PATCH', `/api/v1/icp-profiles/${created.body.id}`, {
      body: { expected_version: 1, name: 'stale' },
    });
    expect(stale.status).toBe(409);

    const bad = await call(env, alice, 'POST', '/api/v1/icp-profiles', {
      body: { name: 'x', definition: { countries: ['gbr'], surprise: true } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('submits a domain idempotently', async () => {
    const first = await call(env, alice, 'POST', '/api/v1/companies', {
      body: { domain: 'https://www.ACME.example/about' },
    });
    expect(first.status).toBe(201);
    expect(first.body.company.primary_domain).toBe(DOMAIN);
    companyId = first.body.company.id;

    const again = await call(env, alice, 'POST', '/api/v1/companies', { body: { domain: DOMAIN } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, company: { id: companyId } });

    const invalid = await call(env, alice, 'POST', '/api/v1/companies', {
      body: { domain: '10.0.0.5' },
    });
    expect(invalid.status).toBe(400);
  });

  it('launches one research job and deduplicates concurrent or repeated submits', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => call(env, alice, 'POST', `/api/v1/companies/${companyId}/research-jobs`)),
    );
    for (const r of results) expect(r.status).toBe(202);
    const ids = new Set(results.map((r) => r.body.job_id));
    expect(ids.size).toBe(1);
    jobId = results[0]!.body.job_id;
    expect(results[0]!.body.status_url).toBe(`/api/v1/research-jobs/${jobId}`);
  });

  it('relays the job to the workflow engine exactly once via the outbox', async () => {
    env.dispatcher.failNext = 1;
    await relayOnce(env.relayDb, env.dispatcher, silent);
    expect(env.dispatcher.started).toHaveLength(0);
    const { rows } = await env.owner.query(
      `SELECT attempts, last_error, next_attempt_at > now() AS deferred FROM outbox_events
       WHERE event_type = 'research.company.requested'`,
    );
    expect(rows[0]).toMatchObject({
      attempts: 1,
      last_error: 'temporal unavailable',
      deferred: true,
    });

    await env.owner.query(`UPDATE outbox_events SET next_attempt_at = now()`);
    await relayOnce(env.relayDb, env.dispatcher, silent);
    await relayOnce(env.relayDb, env.dispatcher, silent);
    expect(env.dispatcher.started).toHaveLength(1);
    expect(env.dispatcher.started[0]).toMatchObject({
      jobId,
      tenantId: alice.workspaceId,
      domain: DOMAIN,
    });
  });

  it('completes with partial success when one source fails', async () => {
    const result = await runMockWorkflow(alice.workspaceId!, jobId, companyId);
    expect(result.status).toBe('partial_success');

    const job = await call(env, alice, 'GET', `/api/v1/research-jobs/${jobId}`);
    expect(job.body.status).toBe('partial_success');
    const bySource = Object.fromEntries(
      job.body.sources.map((s: { source_key: string }) => [s.source_key, s]),
    );
    expect(bySource.mock_web.status).toBe('succeeded');
    expect(bySource.mock_people.status).toBe('succeeded');
    expect(bySource.mock_registry).toMatchObject({
      status: 'failed',
      error_code: 'SOURCE_UNAVAILABLE',
    });
  });

  it('shows the company record enriched only where fields were empty', async () => {
    const res = await call(env, alice, 'GET', `/api/v1/companies/${companyId}`);
    expect(res.body.company).toMatchObject({
      canonical_name: 'Acme Example Ltd',
      industry: 'Software',
      country_code: 'GB',
    });
    expect(res.body.counts).toEqual({ evidence: 2, people: 3 });
  });

  it('lists source evidence with provenance and stores content under the tenant prefix', async () => {
    const res = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/evidence`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    for (const e of res.body.data) {
      expect(e.source_url).toMatch(/^https:\/\/acme\.example\//);
      expect(e.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(e.is_mock).toBe(true);
      expect(e.has_stored_content).toBe(true);
    }
    evidenceId = res.body.data[0].id;
    for (const key of env.storage.objects.keys()) {
      expect(key.startsWith(`tenants/${alice.workspaceId}/`)).toBe(true);
    }

    const url = await call(env, alice, 'GET', `/api/v1/evidence/${evidenceId}/content-url`);
    expect(url.status).toBe(200);
    expect(url.body.url).toContain(`tenants/${alice.workspaceId}/`);
    expect(url.body.expires_in_seconds).toBeLessThanOrEqual(900);
  });

  it('shows candidate people with explicit provenance and explained confidence', async () => {
    const list = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/people`);
    expect(list.body.data).toHaveLength(3);
    const jordan = list.body.data.find(
      (p: { canonical_name: string }) => p.canonical_name === 'Jordan Sample',
    );
    expect(jordan).toMatchObject({
      title: 'Engineering Manager',
      review_status: 'unreviewed',
      evidence_count: 1,
    });
    expect(jordan.confidence).toMatchObject({ value: 0.8, band: 'plausible' });
    personId = jordan.id;

    const detail = await call(env, alice, 'GET', `/api/v1/people/${personId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.claims.length).toBeGreaterThanOrEqual(2);
    for (const claim of detail.body.claims) {
      expect(['source_fact', 'provider_fact']).toContain(claim.claim_type);
      expect(claim.evidence.length).toBeGreaterThan(0);
      expect(claim.evidence[0].source_url).toBe(`https://${DOMAIN}/about/team`);
      expect(claim.confidence.explanation).toMatch(/heuristic/);
    }
    expect(detail.body.contact_points).toEqual([]);
  });

  it('records a review decision with optimistic concurrency', async () => {
    const ok = await call(env, alice, 'POST', `/api/v1/people/${personId}/review`, {
      body: { decision: 'confirm', expected_version: 1, reason: 'Matches team page' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ review_status: 'accepted', version: 2 });

    const stale = await call(env, alice, 'POST', `/api/v1/people/${personId}/review`, {
      body: { decision: 'reject', expected_version: 1 },
    });
    expect(stale.status).toBe(409);
  });

  it('produces an org map that satisfies the v2 contract and separates verified from inferred', async () => {
    const res = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/org-map`);
    expect(res.status).toBe(200);
    expect(validateOrgMapV2(res.body).ok).toBe(true);
    const byPredicate = Object.fromEntries(
      res.body.relationships.map((r: { predicate: string }) => [r.predicate, r]),
    );
    expect(byPredicate.REPORTS_TO).toMatchObject({ status: 'verified', claim_type: 'source_fact' });
    expect(byPredicate.INFLUENCES).toMatchObject({ status: 'inferred' });
    expect(byPredicate.INFLUENCES.rationale).toMatch(/not stated explicitly/);
    for (const r of res.body.relationships) expect(r.evidence_ids.length).toBeGreaterThan(0);
    expect(res.body.people.every((p: { persona: string }) => p.persona === 'unknown')).toBe(true);
  });

  it('records a complete audit trail', async () => {
    const res = await call(env, alice, 'GET', '/api/v1/audit-events?limit=100');
    const actions = res.body.data.map((e: { action: string }) => e.action);
    for (const expected of [
      'workspace.created',
      'icp.created',
      'icp.updated',
      'company.created',
      'research.requested',
      'research.started',
      'research.source.persisted',
      'research.source.failed',
      'research.completed',
      'evidence.content_accessed',
      'person.reviewed',
    ]) {
      expect(actions).toContain(expected);
    }
    for (const e of res.body.data) expect(e.correlation_id).toBeTruthy();
  });

  it('re-running persistence for the same payload does not duplicate records', async () => {
    const acts = createControlActivities({ db: env.db, storage: env.storage });
    await acts.persistSourceResult({
      tenantId: alice.workspaceId!,
      jobId,
      companyId,
      sourceKey: 'mock_people',
      correlationId: 'retry',
      attempts: 2,
      result: peopleResult(DOMAIN),
    });
    const res = await call(env, alice, 'GET', `/api/v1/companies/${companyId}`);
    expect(res.body.counts).toEqual({ evidence: 2, people: 3 });
  });
});

describe('untrusted adapter output', () => {
  let otherCompany: string;
  let otherJob: string;

  beforeAll(async () => {
    const c = await call(env, alice, 'POST', '/api/v1/companies', {
      body: { domain: 'beta.example' },
    });
    otherCompany = c.body.company.id;
    const j = await call(env, alice, 'POST', `/api/v1/companies/${otherCompany}/research-jobs`);
    otherJob = j.body.job_id;
    const acts = createControlActivities({ db: env.db, storage: env.storage });
    await acts.markJobRunning({
      tenantId: alice.workspaceId!,
      jobId: otherJob,
      correlationId: 'x',
    });
  });

  it('quarantines schema-invalid payloads without touching canonical tables', async () => {
    const acts = createControlActivities({ db: env.db, storage: env.storage });
    const bad = peopleResult('beta.example');
    bad.people[0]!.evidence_refs = ['ev-fabricated'];
    const outcome = await acts.persistSourceResult({
      tenantId: alice.workspaceId!,
      jobId: otherJob,
      companyId: otherCompany,
      sourceKey: 'mock_people',
      correlationId: 'x',
      attempts: 1,
      result: bad,
    });
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'ADAPTER_PAYLOAD_INVALID' });
    const res = await call(env, alice, 'GET', `/api/v1/companies/${otherCompany}`);
    expect(res.body.counts).toEqual({ evidence: 0, people: 0 });
  });

  it('rejects website evidence from outside the target domain', async () => {
    const acts = createControlActivities({ db: env.db, storage: env.storage });
    const outcome = await acts.persistSourceResult({
      tenantId: alice.workspaceId!,
      jobId: otherJob,
      companyId: otherCompany,
      sourceKey: 'mock_web',
      correlationId: 'x',
      attempts: 1,
      result: webResult('attacker.example'),
    });
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'SOURCE_POLICY_VIOLATION' });
  });

  it('a background task cannot write into another tenant', async () => {
    const acts = createControlActivities({ db: env.db, storage: env.storage });
    await expect(
      acts.persistSourceResult({
        tenantId: bob.workspaceId!,
        jobId: otherJob,
        companyId: otherCompany,
        sourceKey: 'mock_web',
        correlationId: 'x',
        attempts: 1,
        result: webResult('beta.example'),
      }),
    ).rejects.toThrow(/Job not found/);
  });
});

describe('tenant isolation (API layer)', () => {
  it('hides other tenants entirely (404, not 403)', async () => {
    const urls = [
      `/api/v1/companies/${companyId}`,
      `/api/v1/companies/${companyId}/evidence`,
      `/api/v1/companies/${companyId}/people`,
      `/api/v1/companies/${companyId}/org-map`,
      `/api/v1/research-jobs/${jobId}`,
      `/api/v1/people/${personId}`,
      `/api/v1/evidence/${evidenceId}/content-url`,
    ];
    for (const url of urls) {
      const res = await call(env, bob, 'GET', url);
      expect(res.status, url).toBe(404);
    }
    const review = await call(env, bob, 'POST', `/api/v1/people/${personId}/review`, {
      body: { decision: 'reject', expected_version: 2 },
    });
    expect(review.status).toBe(404);
    const cancel = await call(env, bob, 'POST', `/api/v1/research-jobs/${jobId}/cancel`);
    expect(cancel.status).toBe(404);
    const research = await call(env, bob, 'POST', `/api/v1/companies/${companyId}/research-jobs`);
    expect(research.status).toBe(404);
  });

  it('refuses a forged workspace header', async () => {
    for (const url of ['/api/v1/companies', '/api/v1/audit-events', '/api/v1/icp-profiles']) {
      const res = await call(env, bob, 'GET', url, { workspaceId: alice.workspaceId });
      expect(res.status, url).toBe(404);
    }
    const members = await call(env, bob, 'GET', `/api/v1/workspaces/${alice.workspaceId}/members`);
    expect(members.status).toBe(404);
  });

  it('lists nothing from other tenants', async () => {
    for (const url of ['/api/v1/companies', '/api/v1/icp-profiles']) {
      const res = await call(env, bob, 'GET', url);
      expect(res.body.data, url).toEqual([]);
    }
    const audit = await call(env, bob, 'GET', '/api/v1/audit-events?limit=100');
    for (const e of audit.body.data) expect(e.actor_user_id === alice.userId).toBe(false);
  });

  it('the same domain in two tenants yields two independent companies', async () => {
    const res = await call(env, bob, 'POST', '/api/v1/companies', { body: { domain: DOMAIN } });
    expect(res.status).toBe(201);
    expect(res.body.company.id).not.toBe(companyId);
    const people = await call(env, bob, 'GET', `/api/v1/companies/${res.body.company.id}/people`);
    expect(people.body.data).toEqual([]);
  });
});

describe('RBAC and quotas', () => {
  it('denies writes to auditors and audits the denial', async () => {
    const auditor = await signIn(env, 'dana', 'dana@tenant-a.test');
    await env.owner.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'auditor')`,
      [alice.workspaceId, auditor.userId],
    );
    auditor.workspaceId = alice.workspaceId;

    const read = await call(env, auditor, 'GET', `/api/v1/companies/${companyId}`);
    expect(read.status).toBe(200);
    const write = await call(env, auditor, 'POST', '/api/v1/companies', {
      body: { domain: 'gamma.example' },
    });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('FORBIDDEN');

    const audit = await call(env, alice, 'GET', '/api/v1/audit-events?entity_type=permission');
    expect(audit.body.data[0]).toMatchObject({
      action: 'authz.denied',
      outcome: 'denied',
      actor_user_id: auditor.userId,
    });
  });

  it('enforces the daily research job quota', async () => {
    const c = await call(env, alice, 'POST', '/api/v1/companies', {
      body: { domain: 'delta.example' },
    });
    const over = await call(
      env,
      alice,
      'POST',
      `/api/v1/companies/${c.body.company.id}/research-jobs`,
    );
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('cancellation', () => {
  it('cancels a queued job before the workflow starts work', async () => {
    const c = await call(env, bob, 'POST', '/api/v1/companies', {
      body: { domain: 'epsilon.example' },
    });
    const j = await call(env, bob, 'POST', `/api/v1/companies/${c.body.company.id}/research-jobs`);
    const cancel = await call(env, bob, 'POST', `/api/v1/research-jobs/${j.body.job_id}/cancel`);
    expect(cancel.status).toBe(202);
    expect(env.dispatcher.cancelled).toContain(`research-${j.body.job_id}`);

    const acts = createControlActivities({ db: env.db, storage: env.storage });
    const start = await acts.markJobRunning({
      tenantId: bob.workspaceId!,
      jobId: j.body.job_id,
      correlationId: 'x',
    });
    expect(start).toEqual({ proceed: false, status: 'cancelled' });

    const again = await call(env, bob, 'POST', `/api/v1/research-jobs/${j.body.job_id}/cancel`);
    expect(again.status).toBe(409);
  });
});

describe('sign-in flow', () => {
  it('creates a session from a verified identity and audits it', async () => {
    const login = await env.app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    expect(login.statusCode).toBe(302);
    const stateCookie = login.cookies.find((c) => c.name === 'mf_oidc');
    expect(stateCookie?.httpOnly).toBe(true);

    const callback = await env.app.inject({
      method: 'GET',
      url: '/api/v1/auth/callback?code=good&state=s',
      cookies: { mf_oidc: stateCookie!.value },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toMatch(/\/workspaces$/);
    const session = callback.cookies.find((c) => c.name === 'mf_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

    const me = await env.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { mf_session: session!.value },
    });
    expect(me.json().user.email).toBe('carol@tenant-c.test');
  });

  it('fails closed on a bad code or missing state cookie', async () => {
    const noCookie = await env.app.inject({
      method: 'GET',
      url: '/api/v1/auth/callback?code=good',
    });
    expect(noCookie.headers.location).toMatch(/error=sign_in_failed/);
    const login = await env.app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const stateCookie = login.cookies.find((c) => c.name === 'mf_oidc')!;
    const bad = await env.app.inject({
      method: 'GET',
      url: '/api/v1/auth/callback?code=bad',
      cookies: { mf_oidc: stateCookie.value },
    });
    expect(bad.headers.location).toMatch(/error=sign_in_failed/);
    expect(bad.cookies.find((c) => c.name === 'mf_session')).toBeUndefined();
  });
});
