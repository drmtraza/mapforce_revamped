#!/usr/bin/env node
/**
 * Platform synthetic probe. Requires SYNTHETIC_PROBE_TOKEN on the API and in the env.
 *   node infra/synthetic/probe.mjs
 *   BASE_URL=http://localhost:4000 SYNTHETIC_PROBE_TOKEN=... node infra/synthetic/probe.mjs
 */
const base = process.env.BASE_URL || 'http://localhost:4000';
const token = process.env.SYNTHETIC_PROBE_TOKEN;
if (!token) {
  console.error('SYNTHETIC_PROBE_TOKEN is required');
  process.exit(2);
}
const res = await fetch(`${base}/synthetic/probe`, {
  headers: { 'x-synthetic-token': token },
});
const body = await res.json();
console.log(JSON.stringify({ status: res.status, ...body }));
process.exit(body.ok ? 0 : 1);
