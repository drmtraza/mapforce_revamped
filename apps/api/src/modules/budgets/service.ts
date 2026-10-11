import type { Tx } from '@mapforce/db';
import type { Config } from '../../config.ts';
import { clampToPlan, planCaps } from '../rollout/plans.ts';

export interface TenantLimits {
  research: number;
  enrich: number;
  ai: number;
  export: number;
  provider_cost: number;
  concurrent_jobs: number;
  plan_id: string;
}

export async function loadTenantPlan(trx: Tx, tenantId: string): Promise<string> {
  const row = await trx
    .selectFrom('tenants')
    .select('plan_id')
    .where('id', '=', tenantId)
    .executeTakeFirst();
  return row?.plan_id ?? 'beta';
}

export async function resolveTenantLimits(
  trx: Tx,
  tenantId: string,
  config: Pick<
    Config,
    | 'TENANT_DAILY_RESEARCH_JOB_LIMIT'
    | 'TENANT_DAILY_ENRICH_LIMIT'
    | 'TENANT_DAILY_AI_RUN_LIMIT'
    | 'TENANT_DAILY_EXPORT_LIMIT'
    | 'TENANT_CONCURRENT_JOB_LIMIT'
    | 'TENANT_DAILY_PROVIDER_COST_CEILING'
  >,
): Promise<TenantLimits> {
  const planId = await loadTenantPlan(trx, tenantId);
  const caps = planCaps(planId);
  const row = await trx
    .selectFrom('tenant_budgets')
    .select([
      'daily_research_job_limit',
      'daily_enrich_limit',
      'daily_ai_run_limit',
      'daily_export_limit',
      'daily_provider_cost_ceiling',
    ])
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  return {
    plan_id: planId,
    research: clampToPlan(
      row?.daily_research_job_limit ?? config.TENANT_DAILY_RESEARCH_JOB_LIMIT,
      caps.research,
    ),
    enrich: clampToPlan(row?.daily_enrich_limit ?? config.TENANT_DAILY_ENRICH_LIMIT, caps.enrich),
    ai: clampToPlan(row?.daily_ai_run_limit ?? config.TENANT_DAILY_AI_RUN_LIMIT, caps.ai),
    export: clampToPlan(row?.daily_export_limit ?? config.TENANT_DAILY_EXPORT_LIMIT, caps.export),
    provider_cost: clampToPlan(
      row?.daily_provider_cost_ceiling != null
        ? Number(row.daily_provider_cost_ceiling)
        : config.TENANT_DAILY_PROVIDER_COST_CEILING,
      caps.provider_cost,
    ),
    concurrent_jobs: clampToPlan(config.TENANT_CONCURRENT_JOB_LIMIT, caps.concurrent_jobs),
  };
}

export async function providerCostUsed(trx: Tx, tenantId: string): Promise<number> {
  const since = new Date(Date.now() - 86_400_000);
  const rows = await trx
    .selectFrom('provider_usage')
    .select(['estimated_cost', 'actual_cost'])
    .where('tenant_id', '=', tenantId)
    .where('occurred_at', '>=', since)
    .execute();
  return rows.reduce((n, r) => n + Number(r.actual_cost ?? r.estimated_cost ?? 0), 0);
}

export async function providerCostCeilingExceeded(
  trx: Tx,
  tenantId: string,
  config: Parameters<typeof resolveTenantLimits>[2],
): Promise<boolean> {
  const limits = await resolveTenantLimits(trx, tenantId, config);
  if (limits.provider_cost <= 0) return true;
  const used = await providerCostUsed(trx, tenantId);
  return used >= limits.provider_cost;
}
