import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateOrgMapV2 } from '@mapforce/contracts';
import { persistSourceResult } from '../../src/modules/research/persist.ts';
import { careersResult, peopleResult, webResult } from '../support/adapter-fixtures.ts';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

const DOMAIN = 'acme.example';

let env: TestEnv;
let alice: Actor;
let bob: Actor;
let companyId: string;

beforeAll(async () => {
  env = await startTestEnv({ TENANT_DAILY_AI_RUN_LIMIT: '2' });
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
  const ws = await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice P4' } });
  alice.workspaceId = ws.body.id;
  const bobWs = await call(env, bob, 'POST', '/api/v1/workspaces', { body: { name: 'Bob P4' } });
  bob.workspaceId = bobWs.body.id;

  const company = await call(env, alice, 'POST', '/api/v1/companies', { body: { domain: DOMAIN } });
  companyId = company.body.company.id;
  const job = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/research-jobs`);
  const common = {
    tenantId: alice.workspaceId!,
    jobId: job.body.job_id as string,
    companyId,
    correlationId: 'p4',
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
  await persistSourceResult(env.db, env.storage, {
    ...common,
    sourceKey: 'mock_careers',
    result: careersResult(DOMAIN),
  });
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('AI organization mapping', () => {
  it('leaves personas unknown until an AI run exists', async () => {
    const res = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/org-map`);
    expect(res.status).toBe(200);
    expect(validateOrgMapV2(res.body).ok).toBe(true);
    expect(res.body.people.every((p: { persona: string }) => p.persona === 'unknown')).toBe(true);
  });

  it('runs the mock model in-request and overlays personas plus drafts', async () => {
    const run = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/org-map-jobs`, {
      headers: { 'idempotency-key': 'orgmap-alice-1' },
    });
    expect(run.status).toBe(202);
    expect(run.body.status).toMatch(/succeeded|partial_success/);

    const job = await call(env, alice, 'GET', `/api/v1/org-map-jobs/${run.body.job_id}`);
    expect(job.status).toBe(200);
    expect(job.body.ai_run.provider).toBe('mock');
    expect(job.body.ai_run.validation_outcome).toBe('accepted');

    const map = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/org-map`);
    expect(validateOrgMapV2(map.body).ok).toBe(true);
    const byName = Object.fromEntries(
      map.body.people.map((p: { display_name: string; persona: string }) => [
        p.display_name,
        p.persona,
      ]),
    );
    expect(byName['Avery Example']).toBe('technical_evaluator');
    expect(byName['Jordan Sample']).toBe('operational_user');
    expect(byName['Riley Placeholder']).toBe('procurement');
    expect(map.body.people.every((p: { outreach_angle: unknown }) => p.outreach_angle)).toBe(true);
    expect(JSON.stringify(map.body)).not.toMatch(/@[a-z0-9.-]+\./i);

    const drafts = await call(env, alice, 'GET', `/api/v1/companies/${companyId}/outreach-drafts`);
    expect(drafts.status).toBe(200);
    expect(drafts.body.data.length).toBeGreaterThan(0);
    expect(drafts.body.note).toMatch(/never sends outreach/i);
    expect(
      drafts.body.data.every((d: { claim_type: string }) => d.claim_type === 'model_inference'),
    ).toBe(true);
  });

  it('replays the same idempotency key without creating another job', async () => {
    const first = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/org-map-jobs`, {
      headers: { 'idempotency-key': 'orgmap-alice-1' },
    });
    const second = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/org-map-jobs`, {
      headers: { 'idempotency-key': 'orgmap-alice-1' },
    });
    expect(first.body.job_id).toBe(second.body.job_id);
  });

  it('enforces the daily AI run quota', async () => {
    const second = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/org-map-jobs`, {
      headers: { 'idempotency-key': 'orgmap-alice-2' },
    });
    expect(second.status).toBe(202);
    const third = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/org-map-jobs`, {
      headers: { 'idempotency-key': 'orgmap-alice-3' },
    });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('hides another tenant org-map job and drafts (404)', async () => {
    const map = await call(env, bob, 'GET', `/api/v1/companies/${companyId}/org-map`);
    expect(map.status).toBe(404);
    const drafts = await call(env, bob, 'GET', `/api/v1/companies/${companyId}/outreach-drafts`);
    expect(drafts.status).toBe(404);
    const run = await call(env, bob, 'POST', `/api/v1/companies/${companyId}/org-map-jobs`);
    expect(run.status).toBe(404);
  });
});
