import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { relayOnce } from '../../src/modules/outbox/relay.ts';
import { createControlActivities } from '../../src/temporal/activities.ts';
import { discoveryResult, siteResult, webResult } from '../support/adapter-fixtures.ts';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

const silent = { warn: () => undefined, error: () => undefined };

let env: TestEnv;
let alice: Actor;
let bob: Actor;
let rita: Actor;
let dana: Actor;

const ws = (actor: Actor) => actor.workspaceId as string;
const csv = (actor: Actor, body: string, query: string, headers: Record<string, string> = {}) =>
  call(env, actor, 'POST', `/api/v1/imports/companies?${query}`, {
    body,
    headers: { 'content-type': 'text/csv', ...headers },
  });

async function createCompany(actor: Actor, domain: string): Promise<string> {
  const res = await call(env, actor, 'POST', '/api/v1/companies', { body: { domain } });
  return res.body.company.id as string;
}

async function addMember(actor: Actor, owner: Actor, role: string) {
  await env.owner.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [
    ws(owner),
    actor.userId,
    role,
  ]);
  actor.workspaceId = ws(owner);
}

beforeAll(async () => {
  env = await startTestEnv({ TENANT_DAILY_CRAWL_PAGE_LIMIT: '10' });
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
  rita = await signIn(env, 'rita', 'rita@tenant-a.test');
  dana = await signIn(env, 'dana', 'dana@tenant-a.test');
  alice.workspaceId = (
    await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice Co' } })
  ).body.id;
  bob.workspaceId = (
    await call(env, bob, 'POST', '/api/v1/workspaces', { body: { name: 'Bob Co' } })
  ).body.id;
  await addMember(rita, alice, 'researcher');
  await addMember(dana, alice, 'auditor');
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('source registry and workspace settings', () => {
  it('lists effective sources with the crawler off and Brave unavailable by default', async () => {
    const res = await call(env, alice, 'GET', '/api/v1/sources');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.map((s: { id: string }) => [s.id, s]));
    expect(byId.company_site).toMatchObject({
      globally_enabled: true,
      tenant_enabled: false,
      tenant_setting: 'default',
      available: false,
    });
    expect(byId.brave_search).toMatchObject({
      globally_enabled: false,
      requires_credentials: true,
      available: false,
    });
    expect(byId.mock_search.available).toBe(true);
  });

  it('only owners/admins can change source settings; changes are audited and scoped', async () => {
    const denied = await call(env, rita, 'PATCH', '/api/v1/sources/company_site', {
      body: { enabled: true },
    });
    expect(denied.status).toBe(403);

    const res = await call(env, alice, 'PATCH', '/api/v1/sources/company_site', {
      body: { enabled: true },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tenant_setting: 'enabled', available: true });

    const bobView = await call(env, bob, 'GET', '/api/v1/sources');
    const bobSite = bobView.body.data.find((s: { id: string }) => s.id === 'company_site');
    expect(bobSite.tenant_enabled).toBe(false);

    const audit = await call(env, alice, 'GET', '/api/v1/audit-events?entity_id=company_site');
    expect(audit.body.data.map((e: { action: string }) => e.action)).toContain('source.enabled');
  });

  it('refuses to enable a globally disabled source and rejects unknown keys', async () => {
    const brave = await call(env, alice, 'PATCH', '/api/v1/sources/brave_search', {
      body: { enabled: true },
    });
    expect(brave.status).toBe(409);
    const unknown = await call(env, alice, 'PATCH', '/api/v1/sources/nope_source', {
      body: { enabled: true },
    });
    expect(unknown.status).toBe(404);
  });

  it('plans the crawler for research jobs within the daily page budget', async () => {
    const first = await createCompany(alice, 'budget-one.example');
    const job1 = await call(env, alice, 'POST', `/api/v1/companies/${first}/research-jobs`);
    expect(job1.status).toBe(202);
    const detail1 = await call(env, alice, 'GET', `/api/v1/research-jobs/${job1.body.job_id}`);
    const site1 = detail1.body.sources.find(
      (s: { source_key: string }) => s.source_key === 'company_site',
    );
    expect(site1.status).toBe('pending');

    await relayOnce(env.relayDb, env.dispatcher, silent);
    const input = env.dispatcher.started.find((s) => s.jobId === job1.body.job_id);
    const planned = input?.sources.find((s) => s.sourceKey === 'company_site');
    expect(planned?.maxEvidence).toBe(8);

    // 10-page budget minus 8 reserved by the active job leaves 2 pages.
    const second = await createCompany(alice, 'budget-two.example');
    const job2 = await call(env, alice, 'POST', `/api/v1/companies/${second}/research-jobs`);
    expect(job2.status, JSON.stringify(job2.body)).toBe(202);
    const detail2 = await call(env, alice, 'GET', `/api/v1/research-jobs/${job2.body.job_id}`);
    expect(detail2.body.sources, JSON.stringify(detail2.body)).toContainEqual(
      expect.objectContaining({ source_key: 'company_site', status: 'pending' }),
    );
    await relayOnce(env.relayDb, env.dispatcher, silent);
    const input2 = env.dispatcher.started.find((s) => s.jobId === job2.body.job_id);
    expect(input2?.sources.find((s) => s.sourceKey === 'company_site')?.maxEvidence).toBe(2);

    const third = await createCompany(alice, 'budget-three.example');
    const job3 = await call(env, alice, 'POST', `/api/v1/companies/${third}/research-jobs`);
    const detail3 = await call(env, alice, 'GET', `/api/v1/research-jobs/${job3.body.job_id}`);
    const site3 = detail3.body.sources.find(
      (s: { source_key: string }) => s.source_key === 'company_site',
    );
    expect(site3).toMatchObject({ status: 'skipped', error_code: 'BUDGET_EXHAUSTED' });
  });

  it('rejects crawler evidence that leaves the company domain', async () => {
    const companyId = await createCompany(alice, 'policy.example');
    const job = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/research-jobs`);
    const acts = createControlActivities({ db: env.db, storage: env.storage });
    const ref = { tenantId: ws(alice), jobId: job.body.job_id, correlationId: 'c-policy' };
    await acts.markJobRunning(ref);
    const off = await acts.persistSourceResult({
      ...ref,
      companyId,
      sourceKey: 'company_site',
      attempts: 1,
      result: siteResult('policy.example', 'https://evil.example/'),
    });
    expect(off).toMatchObject({ status: 'failed', errorCode: 'SOURCE_POLICY_VIOLATION' });

    const wrongOp = await acts.persistSourceResult({
      ...ref,
      companyId,
      sourceKey: 'mock_web',
      attempts: 1,
      result: { ...webResult('policy.example'), operation: 'discover_people' },
    });
    expect(wrongOp).toMatchObject({ status: 'failed', errorCode: 'ADAPTER_PAYLOAD_INVALID' });
  });

  it('reports per-source freshness for a company', async () => {
    const companyId = await createCompany(alice, 'fresh.example');
    const job = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/research-jobs`);
    const acts = createControlActivities({ db: env.db, storage: env.storage });
    const ref = { tenantId: ws(alice), jobId: job.body.job_id, correlationId: 'c-fresh' };
    await acts.markJobRunning(ref);
    await acts.persistSourceResult({
      ...ref,
      companyId,
      sourceKey: 'mock_web',
      attempts: 1,
      result: webResult('fresh.example'),
    });
    const res = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/source-freshness`);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(
      res.body.data.map((f: { source_key: string }) => [f.source_key, f]),
    );
    expect(byKey.mock_web.stale).toBe(false);
    expect(byKey.mock_web.last_success_at).not.toBeNull();
    expect(byKey.mock_registry).toMatchObject({ stale: true, last_success_at: null });

    const cross = await call(env, bob, 'GET', `/api/v1/companies/${companyId}/source-freshness`);
    expect(cross.status).toBe(404);
  });
});

describe('company discovery', () => {
  let searchId = '';

  it('validates queries', async () => {
    for (const body of [
      { text: 'ab' },
      { text: 'logistics', country_codes: ['gb'] },
      { text: 'logistics', extra: true },
    ]) {
      const res = await call(env, alice, 'POST', '/api/v1/discovery-searches', { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('starts a discovery job on available discovery sources only', async () => {
    const res = await call(env, alice, 'POST', '/api/v1/discovery-searches', {
      body: { text: 'freight software', country_codes: ['GB', 'DE'] },
      headers: { 'idempotency-key': 'discovery-key-0001' },
    });
    expect(res.status).toBe(202);
    searchId = res.body.job_id;
    const again = await call(env, alice, 'POST', '/api/v1/discovery-searches', {
      body: { text: 'freight software', country_codes: ['GB', 'DE'] },
      headers: { 'idempotency-key': 'discovery-key-0001' },
    });
    expect(again.body.job_id).toBe(searchId);

    await relayOnce(env.relayDb, env.dispatcher, silent);
    const input = env.dispatcher.startedDiscovery.find((d) => d.jobId === searchId);
    expect(input?.sources.map((s) => s.sourceKey)).toEqual(['mock_search']);
    expect(input?.query).toEqual({ text: 'freight software', country_codes: ['GB', 'DE'] });

    const asResearch = await call(env, alice, 'GET', `/api/v1/research-jobs/${searchId}`);
    expect(asResearch.status).toBe(404);
  });

  it('stores candidates with provenance and never creates companies by itself', async () => {
    const before = await env.owner.query(
      'SELECT count(*)::int AS n FROM companies WHERE tenant_id = $1',
      [ws(alice)],
    );
    const acts = createControlActivities({ db: env.db, storage: env.storage });
    const ref = { tenantId: ws(alice), jobId: searchId, correlationId: 'c-disc' };
    await acts.markJobRunning(ref);
    const outcome = await acts.persistDiscoveryResult({
      ...ref,
      sourceKey: 'mock_search',
      attempts: 1,
      result: discoveryResult('freight software'),
    });
    expect(outcome.status).toBe('succeeded');
    const final = await acts.finalizeJob({ ...ref, outcomes: [outcome], cancelled: false });
    expect(final.status).toBe('succeeded');

    const res = await call(env, alice, 'GET', `/api/v1/discovery-searches/${searchId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('succeeded');
    expect(res.body.candidates).toHaveLength(3);
    for (const c of res.body.candidates) {
      expect(c.claim_type).toBe('provider_fact');
      expect(c.evidence_url).toMatch(/^https:\/\/search\.mock\.example\//);
    }
    const keys = [...env.storage.objects.keys()].filter((k) => k.includes('/discovery/'));
    expect(keys.every((k) => k.startsWith(`tenants/${ws(alice)}/discovery/${searchId}/`))).toBe(
      true,
    );
    expect(keys.length).toBe(1);

    const after = await env.owner.query(
      'SELECT count(*)::int AS n FROM companies WHERE tenant_id = $1',
      [ws(alice)],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const list = await call(env, alice, 'GET', '/api/v1/discovery-searches');
    expect(list.body.data[0]).toMatchObject({ id: searchId, candidate_count: 3 });
  });

  it('accepting a candidate creates the company with cited claims; dismissing is final', async () => {
    const search = await call(env, alice, 'GET', `/api/v1/discovery-searches/${searchId}`);
    const byDomain = Object.fromEntries(
      search.body.candidates.map((c: { domain: string }) => [c.domain, c]),
    );
    const northwind = byDomain['northwind-freight.example'];

    const accepted = await call(
      env,
      alice,
      'POST',
      `/api/v1/discovery-candidates/${northwind.id}/accept`,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.created).toBe(true);
    expect(accepted.body.company).toMatchObject({
      primary_domain: 'northwind-freight.example',
      country_code: 'GB',
    });
    const claims = await env.owner.query(
      `SELECT c.predicate, c.claim_type, ce.evidence_record_id
       FROM claims c JOIN claim_evidence ce ON ce.claim_id = c.id
       WHERE c.subject_id = $1 ORDER BY c.predicate`,
      [accepted.body.company.id],
    );
    expect(claims.rows.map((r) => r.predicate)).toEqual([
      'canonical_name',
      'country_code',
      'description',
    ]);
    expect(claims.rows.every((r) => r.claim_type === 'provider_fact')).toBe(true);
    expect(new Set(claims.rows.map((r) => r.evidence_record_id))).toEqual(
      new Set([northwind.evidence_id]),
    );

    // acme.example already exists in another flow? Create it to test linking.
    await createCompany(alice, 'acme.example');
    const acme = byDomain['acme.example'];
    const linked = await call(env, alice, 'POST', `/api/v1/discovery-candidates/${acme.id}/accept`);
    expect(linked.body.created).toBe(false);

    const contoso = byDomain['contoso-logistics.example'];
    const dismissed = await call(
      env,
      alice,
      'POST',
      `/api/v1/discovery-candidates/${contoso.id}/dismiss`,
    );
    expect(dismissed.status).toBe(200);
    const late = await call(
      env,
      alice,
      'POST',
      `/api/v1/discovery-candidates/${contoso.id}/accept`,
    );
    expect(late.status).toBe(409);

    const audit = await call(env, alice, 'GET', '/api/v1/audit-events?limit=100');
    const actions = audit.body.data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'discovery.requested',
        'discovery.started',
        'discovery.source.persisted',
        'discovery.completed',
        'discovery.candidate_accepted',
        'discovery.candidate_dismissed',
      ]),
    );
  });

  it('isolates searches and candidates across workspaces', async () => {
    const search = await call(env, alice, 'GET', `/api/v1/discovery-searches/${searchId}`);
    const candidate = search.body.candidates[0];
    expect((await call(env, bob, 'GET', `/api/v1/discovery-searches/${searchId}`)).status).toBe(
      404,
    );
    expect(
      (await call(env, bob, 'POST', `/api/v1/discovery-candidates/${candidate.id}/accept`)).status,
    ).toBe(404);
    expect(
      (await call(env, bob, 'POST', `/api/v1/discovery-candidates/${candidate.id}/dismiss`)).status,
    ).toBe(404);
    expect((await call(env, bob, 'GET', '/api/v1/discovery-searches')).body.data).toEqual([]);
  });

  it('rejects discovery payloads that carry people or non-public evidence', async () => {
    const res = await call(env, alice, 'POST', '/api/v1/discovery-searches', {
      body: { text: 'policy checks' },
      headers: { 'idempotency-key': 'discovery-key-0002' },
    });
    const jobId = res.body.job_id;
    const acts = createControlActivities({ db: env.db, storage: env.storage });
    const ref = { tenantId: ws(alice), jobId, correlationId: 'c-disc-2' };
    await acts.markJobRunning(ref);
    const bad = discoveryResult('policy checks');
    bad.evidence[0]!.source_url = 'https://127.0.0.1/search';
    const outcome = await acts.persistDiscoveryResult({
      ...ref,
      sourceKey: 'mock_search',
      attempts: 1,
      result: bad,
    });
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'SOURCE_POLICY_VIOLATION' });

    const internal = discoveryResult('policy checks');
    internal.companies![0]!.domain = 'intranet.corp';
    const outcome2 = await acts.persistDiscoveryResult({
      ...ref,
      sourceKey: 'mock_search',
      attempts: 1,
      result: internal,
    });
    expect(outcome2).toMatchObject({ status: 'failed', errorCode: 'SOURCE_POLICY_VIOLATION' });
    const rows = await env.owner.query(
      'SELECT count(*)::int AS n FROM discovery_candidates WHERE job_id = $1',
      [jobId],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

describe('CSV company import', () => {
  const file = [
    'Domain,Name,Country_Code,Notes',
    'https://www.Globex.example/about,"Globex, Inc.",gb,ignored',
    'initech.example,Initech,US,',
    'globex.example,Globex duplicate,GB,',
    'not a domain,Bad,GB,',
    '10.0.0.1,IP,GB,',
    'umbrella.example,Umbrella,GBR,',
    'acme.example,Acme existing,GB,',
    ',No domain,GB,',
  ].join('\r\n');

  it('previews a dry run without writing anything', async () => {
    const before = await env.owner.query('SELECT count(*)::int AS n FROM companies');
    const res = await csv(alice, file, 'dry_run=true');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ import_id: null, dry_run: true, ignored_columns: ['notes'] });
    expect(res.body.summary).toEqual({
      rows: 8,
      created: 2,
      existing: 1,
      duplicate_in_file: 1,
      invalid: 4,
    });
    const codes = res.body.rows.map((r: { error_code: string | null }) => r.error_code);
    expect(codes).toEqual([
      null,
      null,
      null,
      'INVALID_DOMAIN',
      'INVALID_DOMAIN',
      'INVALID_COUNTRY',
      null,
      'MISSING_DOMAIN',
    ]);
    expect(res.body.rows[0]).toMatchObject({
      normalized_domain: 'globex.example',
      name: 'Globex, Inc.',
    });
    const after = await env.owner.query('SELECT count(*)::int AS n FROM companies');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const batches = await env.owner.query('SELECT count(*)::int AS n FROM import_batches');
    expect(batches.rows[0].n).toBe(0);
  });

  it('requires an idempotency key to commit and enforces role permissions', async () => {
    expect((await csv(alice, file, 'dry_run=false')).status).toBe(400);
    expect(
      (await csv(dana, file, 'dry_run=false', { 'idempotency-key': 'import-key-dana' })).status,
    ).toBe(403);
  });

  let importId = '';
  it('commits once per key with user-asserted provenance', async () => {
    const res = await csv(rita, file, 'dry_run=false&filename=leads.csv', {
      'idempotency-key': 'import-key-0001',
    });
    expect(res.status).toBe(201);
    importId = res.body.import_id;
    expect(res.body.summary.created).toBe(2);

    const company = await env.owner.query(
      `SELECT id, canonical_name, country_code FROM companies WHERE tenant_id = $1 AND primary_domain = 'globex.example'`,
      [ws(alice)],
    );
    expect(company.rows[0]).toMatchObject({ canonical_name: 'Globex, Inc.', country_code: 'GB' });
    const claims = await env.owner.query(
      `SELECT predicate, claim_type, rationale FROM claims WHERE subject_id = $1 ORDER BY predicate`,
      [company.rows[0].id],
    );
    expect(claims.rows.map((c) => c.predicate)).toEqual(['canonical_name', 'country_code']);
    expect(claims.rows.every((c) => c.claim_type === 'user_assertion')).toBe(true);
    expect(claims.rows[0].rationale).toContain(importId);

    const replay = await csv(rita, file, 'dry_run=false', { 'idempotency-key': 'import-key-0001' });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ import_id: importId, replayed: true });

    const conflict = await csv(rita, `${file}\r\nextra.example,,,`, 'dry_run=false', {
      'idempotency-key': 'import-key-0001',
    });
    expect(conflict.status).toBe(409);

    const count = await env.owner.query(
      `SELECT count(*)::int AS n FROM companies WHERE tenant_id = $1 AND primary_domain IN ('globex.example','initech.example')`,
      [ws(alice)],
    );
    expect(count.rows[0].n).toBe(2);
  });

  it('lists imports and filters rows by outcome, within the workspace only', async () => {
    const list = await call(env, alice, 'GET', '/api/v1/imports');
    expect(list.body.data.map((b: { id: string }) => b.id)).toEqual([importId]);
    expect(list.body.data[0]).toMatchObject({ filename: 'leads.csv' });

    const invalid = await call(env, alice, 'GET', `/api/v1/imports/${importId}?outcome=invalid`);
    expect(invalid.body.rows).toHaveLength(4);
    const paged = await call(env, alice, 'GET', `/api/v1/imports/${importId}?limit=3`);
    expect(paged.body.rows).toHaveLength(3);
    expect(paged.body.next_after_row).toBe(3);

    expect((await call(env, bob, 'GET', `/api/v1/imports/${importId}`)).status).toBe(404);
    expect((await call(env, bob, 'GET', '/api/v1/imports')).body.data).toEqual([]);
  });

  it('rejects malformed files and enforces size and row limits', async () => {
    expect((await csv(alice, 'name\nAcme', 'dry_run=true')).status).toBe(400);
    expect((await csv(alice, 'domain\n"unterminated', 'dry_run=true')).status).toBe(400);
    const tooMany = ['domain', ...Array.from({ length: 5001 }, (_, i) => `d${i}.example`)].join(
      '\n',
    );
    expect((await csv(alice, tooMany, 'dry_run=true')).status).toBe(400);
    const huge = `domain\n${'a'.repeat(1_100_000)}.example`;
    expect((await csv(alice, huge, 'dry_run=true')).status).toBe(413);
  });
});

describe('dead-letter replay', () => {
  async function deadLetter(tenantId: string): Promise<string> {
    const id = randomUUID();
    await env.owner.query(
      `INSERT INTO outbox_events (id, tenant_id, event_type, correlation_id, idempotency_key, payload,
         attempts, last_error, dead_lettered_at)
       VALUES ($1, $2, 'crawl.evidence.created', 'c-dlq', $3, '{}', 10, 'boom', now())`,
      [id, tenantId, `dlq-${id}`],
    );
    return id;
  }

  it('lets workspace owners list and replay only their own dead letters', async () => {
    const mine = await deadLetter(ws(alice));
    const theirs = await deadLetter(ws(bob));

    expect((await call(env, rita, 'GET', '/api/v1/dead-letters')).status).toBe(403);
    const list = await call(env, alice, 'GET', '/api/v1/dead-letters');
    expect(list.status).toBe(200);
    const ids = list.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    expect(list.body.data[0]).not.toHaveProperty('payload');

    expect((await call(env, alice, 'POST', `/api/v1/dead-letters/${theirs}/replay`)).status).toBe(
      404,
    );
    const replay = await call(env, alice, 'POST', `/api/v1/dead-letters/${mine}/replay`);
    expect(replay.status).toBe(202);
    const row = await env.owner.query(
      'SELECT attempts, dead_lettered_at, published_at FROM outbox_events WHERE id = $1',
      [mine],
    );
    expect(row.rows[0]).toMatchObject({ attempts: 0, dead_lettered_at: null });
    expect((await call(env, alice, 'POST', `/api/v1/dead-letters/${mine}/replay`)).status).toBe(
      409,
    );

    await relayOnce(env.relayDb, env.dispatcher, silent, 200);
    const delivered = await env.owner.query(
      'SELECT published_at FROM outbox_events WHERE id = $1',
      [mine],
    );
    expect(delivered.rows[0].published_at).not.toBeNull();

    const audit = await call(env, alice, 'GET', `/api/v1/audit-events?entity_id=${mine}`);
    expect(audit.body.data.map((e: { action: string }) => e.action)).toContain('outbox.replayed');
  });
});
