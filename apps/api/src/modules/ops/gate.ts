import type { Tx } from '@mapforce/db';
import { AppError } from '../../errors.ts';
import type { Config } from '../../config.ts';
import { providerCostCeilingExceeded, resolveTenantLimits } from '../budgets/service.ts';
import { concurrentJobLimitExceeded } from '../jobs/service.ts';
import { assertEnabled, resolveWorkspaceControls, type ControlKey } from './controls.ts';

type GateConfig = Pick<
  Config,
  | 'FEATURE_RESEARCH'
  | 'FEATURE_DISCOVERY'
  | 'FEATURE_ENRICH'
  | 'FEATURE_AI'
  | 'FEATURE_EXPORT'
  | 'TENANT_CONCURRENT_JOB_LIMIT'
  | 'TENANT_DAILY_RESEARCH_JOB_LIMIT'
  | 'TENANT_DAILY_ENRICH_LIMIT'
  | 'TENANT_DAILY_AI_RUN_LIMIT'
  | 'TENANT_DAILY_EXPORT_LIMIT'
  | 'TENANT_DAILY_PROVIDER_COST_CEILING'
>;

export async function assertCapability(
  trx: Tx,
  tenantId: string,
  config: GateConfig,
  key: ControlKey,
  label: string,
) {
  const controls = await resolveWorkspaceControls(trx, tenantId, config);
  assertEnabled(controls, key, label);
}

export async function assertJobCapacity(trx: Tx, tenantId: string, config: GateConfig) {
  const limits = await resolveTenantLimits(trx, tenantId, config);
  if (await concurrentJobLimitExceeded(trx, tenantId, limits.concurrent_jobs)) {
    throw new AppError(
      'QUOTA_EXCEEDED',
      'Concurrent job limit reached for this workspace. Wait for in-flight jobs to finish.',
    );
  }
  if (await providerCostCeilingExceeded(trx, tenantId, config)) {
    throw new AppError(
      'QUOTA_EXCEEDED',
      'Daily provider cost ceiling reached for this workspace plan.',
    );
  }
}
