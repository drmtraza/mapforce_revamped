import type { TenantPlanId } from '@mapforce/db';

/** Plan ceilings are packaging caps, not proof of scale capacity. */
export interface PlanCaps {
  research: number;
  enrich: number;
  ai: number;
  export: number;
  provider_cost: number;
  concurrent_jobs: number;
}

export const PLAN_CAPS: Record<TenantPlanId, PlanCaps> = {
  development: {
    research: 100,
    enrich: 50,
    ai: 20,
    export: 20,
    provider_cost: 25,
    concurrent_jobs: 8,
  },
  beta: {
    research: 40,
    enrich: 20,
    ai: 10,
    export: 8,
    provider_cost: 5,
    concurrent_jobs: 4,
  },
  ga: {
    research: 200,
    enrich: 80,
    ai: 40,
    export: 30,
    provider_cost: 50,
    concurrent_jobs: 12,
  },
};

export const PLAN_IDS = Object.keys(PLAN_CAPS) as TenantPlanId[];

export function isPlanId(value: string): value is TenantPlanId {
  return value === 'development' || value === 'beta' || value === 'ga';
}

export function planCaps(planId: string): PlanCaps {
  return isPlanId(planId) ? PLAN_CAPS[planId] : PLAN_CAPS.beta;
}

/** Effective limit is the tighter of the admin override (or env default) and the plan ceiling. */
export function clampToPlan(value: number, ceiling: number): number {
  return Math.min(Math.max(0, value), ceiling);
}
