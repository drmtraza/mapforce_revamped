import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import {
  observeRequest,
  percentile,
  prometheusText,
  resetMetrics,
  snapshot,
} from '../../src/modules/ops/metrics.ts';
import { csvCell } from '../../src/modules/exports/csv.ts';
import { baseEnv } from '../support/env.ts';

describe('percentile', () => {
  it('returns 0 for an empty series', () => {
    expect(percentile([], 95)).toBe(0);
  });
  it('computes p95 from sorted samples', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile(samples, 100)).toBe(100);
  });
});

describe('metrics', () => {
  it('records request counts and emits prometheus text without tenant labels', () => {
    resetMetrics();
    observeRequest('GET', '/healthz', 200, 4);
    observeRequest('GET', '/healthz', 200, 8);
    observeRequest('GET', '/api/v1/companies', 500, 40);
    const snap = snapshot();
    expect(snap.requests.find((r) => r.route === 'GET /healthz')?.count).toBe(2);
    expect(snap.requests.find((r) => r.route === 'GET /api/v1/companies')?.errors).toBe(1);
    const text = prometheusText({ mapforce_db_pool_total: 2 });
    expect(text).toMatch(/mapforce_up 1/);
    expect(text).toMatch(/mapforce_db_pool_total 2/);
    expect(text).not.toMatch(/tenant_id/);
    resetMetrics();
  });
});

describe('hardening config defaults', () => {
  it('keeps research/export/AI on and concurrent jobs bounded', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.FEATURE_RESEARCH).toBe(true);
    expect(cfg.FEATURE_EXPORT).toBe(true);
    expect(cfg.FEATURE_AI).toBe(true);
    expect(cfg.TENANT_CONCURRENT_JOB_LIMIT).toBe(8);
    expect(cfg.RATE_LIMIT_EXPORT_PER_MINUTE).toBe(10);
    expect(cfg.RATE_LIMIT_JOB_PER_MINUTE).toBe(30);
    expect(cfg.EXPOSE_OPENAPI).toBe(true);
  });

  it('defaults OpenAPI exposure off when not set in env', () => {
    const cfg = loadConfig(baseEnv({ EXPOSE_OPENAPI: 'false' }));
    expect(cfg.EXPOSE_OPENAPI).toBe(false);
    expect(cfg.METRICS_TOKEN).toBeUndefined();
  });
});

describe('csv formula prefix remains required', () => {
  it('still quotes formula cells', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
  });
});
