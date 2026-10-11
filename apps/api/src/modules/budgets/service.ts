import type { Tx } from '@mapforce/db';
import type { Config } from '../../config.ts';

export interface TenantLimits {
  research: number;
  enrich: number;
  ai: number;
  export: number;
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
  >,
): Promise<TenantLimits> {
  const row = await trx
    .selectFrom('tenant_budgets')
    .select([
      'daily_research_job_limit',
      'daily_enrich_limit',
      'daily_ai_run_limit',
      'daily_export_limit',
    ])
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  return {
    research: row?.daily_research_job_limit ?? config.TENANT_DAILY_RESEARCH_JOB_LIMIT,
    enrich: row?.daily_enrich_limit ?? config.TENANT_DAILY_ENRICH_LIMIT,
    ai: row?.daily_ai_run_limit ?? config.TENANT_DAILY_AI_RUN_LIMIT,
    export: row?.daily_export_limit ?? config.TENANT_DAILY_EXPORT_LIMIT,
  };
}
