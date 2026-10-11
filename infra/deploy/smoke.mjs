#!/usr/bin/env node
/**
 * Post-deploy smoke checks for a packaging/staging API.
 *
 *   BASE_URL=http://localhost:4000 \
 *   METRICS_TOKEN=... SYNTHETIC_PROBE_TOKEN=... \
 *   node infra/deploy/smoke.mjs
 *
 * Expects staging gates: EXPOSE_OPENAPI=false, METRICS_TOKEN set, SYNTHETIC_PROBE_TOKEN set.
 * Does not sign in, create tenants, or claim capacity.
 */
const base = (process.env.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const metricsToken = process.env.METRICS_TOKEN;
const probeToken = process.env.SYNTHETIC_PROBE_TOKEN;
const webBase = (process.env.WEB_BASE_URL || '').replace(/\/$/, '');

const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.error(`ok  ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.error(`FAIL ${name}: ${msg}`);
  }
}

await check('GET /healthz', async () => {
  const res = await fetch(`${base}/healthz`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error(JSON.stringify(body));
});

await check('GET /readyz', async () => {
  const res = await fetch(`${base}/readyz`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = await res.json();
  if (body.status !== 'ready') throw new Error(JSON.stringify(body));
});

await check('GET /metrics without token is hidden', async () => {
  const res = await fetch(`${base}/metrics`);
  if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
});

await check('GET /metrics with token', async () => {
  if (!metricsToken) throw new Error('METRICS_TOKEN is required for this check');
  const res = await fetch(`${base}/metrics`, {
    headers: { 'x-metrics-token': metricsToken },
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const text = await res.text();
  if (!text.includes('mapforce_up 1')) throw new Error('missing mapforce_up');
});

await check('GET /api/v1/openapi.json hidden', async () => {
  const res = await fetch(`${base}/api/v1/openapi.json`);
  if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
});

await check('GET /synthetic/probe', async () => {
  if (!probeToken) throw new Error('SYNTHETIC_PROBE_TOKEN is required for this check');
  const res = await fetch(`${base}/synthetic/probe`, {
    headers: { 'x-synthetic-token': probeToken },
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(JSON.stringify({ status: res.status, body }));
});

if (webBase) {
  await check('GET web /login', async () => {
    const res = await fetch(`${webBase}/login`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  });
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }));
  process.exit(1);
}
console.error(JSON.stringify({ ok: true, base, web: webBase || null }));
process.exit(0);
