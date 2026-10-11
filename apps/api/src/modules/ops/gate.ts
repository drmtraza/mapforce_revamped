import type { Tx } from '@mapforce/db';
import { AppError } from '../../errors.ts';
import type { Config } from '../../config.ts';
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
  if (await concurrentJobLimitExceeded(trx, tenantId, config.TENANT_CONCURRENT_JOB_LIMIT)) {
    throw new AppError(
      'QUOTA_EXCEEDED',
      'Concurrent job limit reached for this workspace. Wait for in-flight jobs to finish.',
    );
  }
}
