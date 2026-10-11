import type { Tx } from '@mapforce/db';
import { AppError } from '../../errors.ts';
import type { Config } from '../../config.ts';

export type ControlKey = 'research' | 'discovery' | 'enrich' | 'ai' | 'export';

export interface WorkspaceControls {
  research: boolean;
  discovery: boolean;
  enrich: boolean;
  ai: boolean;
  export: boolean;
}

export async function resolveWorkspaceControls(
  trx: Tx,
  tenantId: string,
  config: Pick<
    Config,
    'FEATURE_RESEARCH' | 'FEATURE_DISCOVERY' | 'FEATURE_ENRICH' | 'FEATURE_AI' | 'FEATURE_EXPORT'
  >,
): Promise<WorkspaceControls> {
  const row = await trx
    .selectFrom('workspace_controls')
    .select([
      'research_enabled',
      'discovery_enabled',
      'enrich_enabled',
      'ai_enabled',
      'export_enabled',
    ])
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  return {
    research: config.FEATURE_RESEARCH && (row?.research_enabled ?? true),
    discovery: config.FEATURE_DISCOVERY && (row?.discovery_enabled ?? true),
    enrich: config.FEATURE_ENRICH && (row?.enrich_enabled ?? true),
    ai: config.FEATURE_AI && (row?.ai_enabled ?? true),
    export: config.FEATURE_EXPORT && (row?.export_enabled ?? true),
  };
}

export function assertEnabled(controls: WorkspaceControls, key: ControlKey, label: string) {
  if (!controls[key]) {
    throw new AppError('FEATURE_DISABLED', `${label} is disabled for this workspace.`);
  }
}
