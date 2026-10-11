import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { persistSourceResult } from '../../src/modules/research/persist.ts';
import { percentile, resetMetrics } from '../../src/modules/ops/metrics.ts';
import { webResult } from '../support/adapter-fixtures.ts';
import { call, signIn, startTestEnv, type Actor, type TestEnv } from '../support/harness.ts';

const DOMAIN = 'ops.example';

let env: TestEnv;
let alice: Actor;
let bob: Actor;
let companyId: string;

beforeAll(async () => {
  env = await startTestEnv({ TENANT_CONCURRENT_JOB_LIMIT: '1' });
  alice = await signIn(env, 'alice', 'alice@tenant-a.test');
  bob = await signIn(env, 'bob', 'bob@tenant-b.test');
  const ws = await call(env, alice, 'POST', '/api/v1/workspaces', { body: { name: 'Alice P6' } });
  alice.workspaceId = ws.body.id;
  const bobWs = await call(env, bob, 'POST', '/api/v1/workspaces', { body: { name: 'Bob P6' } });
  bob.workspaceId = bobWs.body.id;
  const company = await call(env, alice, 'POST', '/api/v1/companies', {
    body: { domain: DOMAIN, name: 'Ops Example' },
  });
  companyId = company.body.company.id;
  const job = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/research-jobs`);
  await persistSourceResult(env.db, env.storage, {
    tenantId: alice.workspaceId!,
    jobId: job.body.job_id as string,
    companyId,
    correlationId: 'p6',
    attempts: 1,
    sourceKey: 'mock_web',
    result: webResult(DOMAIN),
  });
}, 300_000);

afterAll(async () => {
  await env?.close();
});

describe('hardening', () => {
  it('serves liveness, readiness and process metrics', async () => {
    const health = await env.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });
    const ready = await env.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.database).toBe('ok');
    const metrics = await env.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toMatch(/mapforce_up 1/);
    expect(metrics.body).not.toMatch(/tenant_id=/);
  });

  it('hides OpenAPI when EXPOSE_OPENAPI is false', async () => {
    const locked = await startTestEnv({ EXPOSE_OPENAPI: 'false' });
    try {
      const res = await locked.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
      expect(res.statusCode).toBe(404);
    } finally {
      await locked.close();
    }
  });

  it('exposes ops status and hides it from another tenant', async () => {
    const status = await call(env, alice, 'GET', '/api/v1/ops/status');
    expect(status.status).toBe(200);
    expect(status.body.database).toBe('ok');
    expect(status.body.controls.research).toBe(true);
    expect(status.body.limits.concurrent_jobs).toBe(1);
    expect(status.body.note).toMatch(/not a production SLO/);
    expect((await call(env, bob, 'GET', '/api/v1/ops/status')).status).toBe(200);
    expect((await call(env, bob, 'GET', `/api/v1/companies/${companyId}`)).status).toBe(404);
  });

  it('kill-switch blocks research and is tenant-scoped', async () => {
    const off = await call(env, alice, 'PATCH', '/api/v1/workspace-controls', {
      body: { research_enabled: false },
    });
    expect(off.status).toBe(200);
    expect(off.body.research).toBe(false);
    const blocked = await call(env, alice, 'POST', `/api/v1/companies/${companyId}/research-jobs`);
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('FEATURE_DISABLED');
    const bobCompany = await call(env, bob, 'POST', '/api/v1/companies', {
      body: { domain: 'bob-ops.example', name: 'Bob Ops' },
    });
    const bobJob = await call(
      env,
      bob,
      'POST',
      `/api/v1/companies/${bobCompany.body.company.id}/research-jobs`,
    );
    expect(bobJob.status).toBe(202);
    const on = await call(env, alice, 'PATCH', '/api/v1/workspace-controls', {
      body: { research_enabled: true },
    });
    expect(on.body.research).toBe(true);
  });

  it('enforces a per-tenant concurrent job cap', async () => {
    const extra = await call(env, alice, 'POST', '/api/v1/companies', {
      body: { domain: 'second-ops.example', name: 'Second Ops' },
    });
    const second = await call(
      env,
      alice,
      'POST',
      `/api/v1/companies/${extra.body.company.id}/research-jobs`,
    );
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(second.body.error.message).toMatch(/Concurrent job limit/);
  });

  it('redacts expired evidence excerpts and keeps suppression hashes', async () => {
    await env.owner.query(
      `UPDATE evidence_records SET retention_until = now() - interval '1 day'
        WHERE tenant_id = $1 AND excerpt IS NOT NULL`,
      [alice.workspaceId],
    );
    const report = await call(env, alice, 'GET', '/api/v1/ops/retention');
    expect(report.status).toBe(200);
    expect(report.body.expired_evidence_with_excerpt).toBeGreaterThan(0);
    const sweep = await call(env, alice, 'POST', '/api/v1/ops/retention-sweep');
    expect(sweep.status).toBe(200);
    expect(sweep.body.redacted).toBeGreaterThan(0);
    const after = await call(env, alice, 'GET', '/api/v1/ops/retention');
    expect(after.body.expired_evidence_with_excerpt).toBe(0);
    expect((await call(env, bob, 'POST', '/api/v1/ops/retention-sweep')).status).toBe(200);
    expect((await call(env, bob, 'POST', '/api/v1/ops/retention-sweep')).body.redacted).toBe(0);
  });

  it('measures in-process read latency without claiming scale', async () => {
    resetMetrics();
    const samples: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const started = performance.now();
      const res = await call(env, alice, 'GET', '/api/v1/companies');
      expect(res.status).toBe(200);
      samples.push(performance.now() - started);
    }
    const p95 = percentile(samples, 95);
    expect(p95).toBeGreaterThan(0);
    expect(p95).toBeLessThan(2_000);
  });
});
