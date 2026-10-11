import { describe, expect, it } from 'vitest';
import { clampToPlan, planCaps, PLAN_CAPS } from '../../src/modules/rollout/plans.ts';
import { loadConfig } from '../../src/config.ts';
import { baseEnv } from '../support/env.ts';

describe('plan caps', () => {
  it('keeps beta tighter than development and ga', () => {
    expect(PLAN_CAPS.beta.research).toBeLessThan(PLAN_CAPS.development.research);
    expect(PLAN_CAPS.beta.provider_cost).toBeLessThan(PLAN_CAPS.ga.provider_cost);
    expect(planCaps('unknown').research).toBe(PLAN_CAPS.beta.research);
  });

  it('clamps overrides to the plan ceiling', () => {
    expect(clampToPlan(999, 40)).toBe(40);
    expect(clampToPlan(10, 40)).toBe(10);
    expect(clampToPlan(-1, 40)).toBe(0);
  });
});

describe('rollout config', () => {
  it('accepts beta defaults and provider cost ceilings', () => {
    const cfg = loadConfig(
      baseEnv({
        DEFAULT_TENANT_PLAN: 'beta',
        MAX_BETA_TENANTS: '3',
        TENANT_DAILY_PROVIDER_COST_CEILING: '5',
      }),
    );
    expect(cfg.DEFAULT_TENANT_PLAN).toBe('beta');
    expect(cfg.MAX_BETA_TENANTS).toBe(3);
    expect(cfg.TENANT_DAILY_PROVIDER_COST_CEILING).toBe(5);
    expect(loadConfig(baseEnv()).DEFAULT_TENANT_PLAN).toBe('development');
  });
});
