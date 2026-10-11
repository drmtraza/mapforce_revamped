import type { AdapterOperation } from '@mapforce/contracts';
import type { Tx } from '@mapforce/db';
import type { Config } from '../../config.ts';
import type { SourcePlan } from '../../temporal/types.ts';

export const CRAWLER_SOURCE_TYPE = 'company_website';

export interface EffectiveSource {
  id: string;
  provider_name: string;
  source_type: string;
  description: string;
  operations: string[];
  terms_reference: string;
  is_mock: boolean;
  requires_credentials: boolean;
  globally_enabled: boolean;
  tenant_enabled: boolean;
  tenant_setting: 'default' | 'enabled' | 'disabled';
  available: boolean;
  unavailable_reason: string | null;
  freshness_ttl_hours: number;
  retention_days: number;
  max_requests_per_job: number;
}

/** Registry joined with the workspace's settings. Global `enabled` always wins. */
export async function listEffectiveSources(
  trx: Tx,
  tenantId: string,
  config: Pick<Config, 'FEATURE_MOCK_PROVIDERS'>,
): Promise<EffectiveSource[]> {
  const rows = await trx
    .selectFrom('source_registry as s')
    .leftJoin('tenant_source_settings as t', (join) =>
      join.onRef('t.source_key', '=', 's.id').on('t.tenant_id', '=', tenantId),
    )
    .select([
      's.id',
      's.provider_name',
      's.source_type',
      's.description',
      's.operations',
      's.terms_reference',
      's.is_mock',
      's.requires_credentials',
      's.enabled',
      's.default_tenant_enabled',
      's.freshness_ttl_hours',
      's.retention_days',
      's.max_requests_per_job',
      't.enabled as tenant_value',
    ])
    .orderBy('s.id')
    .execute();

  return rows.map((r) => {
    const tenantEnabled = r.tenant_value ?? r.default_tenant_enabled;
    const reason = !r.enabled
      ? 'Disabled by the platform owner.'
      : r.is_mock && !config.FEATURE_MOCK_PROVIDERS
        ? 'Mock providers are turned off in this environment.'
        : !tenantEnabled
          ? 'Turned off for this workspace.'
          : null;
    return {
      id: r.id,
      provider_name: r.provider_name,
      source_type: r.source_type,
      description: r.description,
      operations: r.operations,
      terms_reference: r.terms_reference,
      is_mock: r.is_mock,
      requires_credentials: r.requires_credentials,
      globally_enabled: r.enabled,
      tenant_enabled: tenantEnabled,
      tenant_setting: r.tenant_value === null ? 'default' : r.tenant_value ? 'enabled' : 'disabled',
      available: reason === null,
      unavailable_reason: reason,
      freshness_ttl_hours: r.freshness_ttl_hours,
      retention_days: r.retention_days,
      max_requests_per_job: r.max_requests_per_job,
    };
  });
}

export interface PlannedSources {
  run: SourcePlan[];
  skipped: { sourceKey: string; errorCode: string; errorSummary: string }[];
}

/**
 * Chooses the sources a job will call: available sources that support one of the
 * requested operations. Crawl sources are capped by the workspace's remaining daily
 * page budget; an exhausted budget skips the source rather than failing the job.
 */
export async function planSources(
  trx: Tx,
  tenantId: string,
  config: Pick<Config, 'FEATURE_MOCK_PROVIDERS' | 'TENANT_DAILY_CRAWL_PAGE_LIMIT'>,
  operations: readonly AdapterOperation[],
  defaults: { maxEvidence: number; maxRecords: number },
): Promise<PlannedSources> {
  const sources = await listEffectiveSources(trx, tenantId, config);
  const plan: PlannedSources = { run: [], skipped: [] };
  let crawlPagesLeft: number | null = null;

  for (const s of sources) {
    if (!s.available) continue;
    const operation = operations.find((op) => s.operations.includes(op));
    if (!operation) continue;

    let maxEvidence = Math.min(defaults.maxEvidence, s.max_requests_per_job);
    if (s.source_type === CRAWLER_SOURCE_TYPE && !s.is_mock) {
      crawlPagesLeft ??= await remainingCrawlPages(trx, tenantId, config);
      if (crawlPagesLeft <= 0) {
        plan.skipped.push({
          sourceKey: s.id,
          errorCode: 'BUDGET_EXHAUSTED',
          errorSummary: 'Daily crawl page budget for this workspace is used up.',
        });
        continue;
      }
      maxEvidence = Math.min(s.max_requests_per_job, crawlPagesLeft);
      crawlPagesLeft -= maxEvidence;
    }
    plan.run.push({
      sourceKey: s.id,
      operation,
      maxEvidence,
      maxRecords: defaults.maxRecords,
    });
  }
  return plan;
}

async function remainingCrawlPages(
  trx: Tx,
  tenantId: string,
  config: Pick<Config, 'TENANT_DAILY_CRAWL_PAGE_LIMIT'>,
): Promise<number> {
  const since = new Date(Date.now() - 86_400_000);
  const used = await trx
    .selectFrom('provider_usage as u')
    .innerJoin('source_registry as s', 's.id', 'u.source_key')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('u.units'), eb.val('0')).as('pages'))
    .where('u.tenant_id', '=', tenantId)
    .where('s.source_type', '=', CRAWLER_SOURCE_TYPE)
    .where('s.is_mock', '=', false)
    .where('u.occurred_at', '>=', since)
    .executeTakeFirstOrThrow();
  // Pages promised to jobs that have not reported usage yet also count against the budget.
  const reserved = await trx
    .selectFrom('workflow_job_sources as js')
    .innerJoin('source_registry as s', 's.id', 'js.source_key')
    .innerJoin('workflow_jobs as j', 'j.id', 'js.job_id')
    .select((eb) =>
      eb.fn.coalesce(eb.fn.sum<string>('s.max_requests_per_job'), eb.val('0')).as('pages'),
    )
    .where('js.tenant_id', '=', tenantId)
    .where('s.source_type', '=', CRAWLER_SOURCE_TYPE)
    .where('s.is_mock', '=', false)
    .where('js.status', 'in', ['pending', 'running'])
    .where('j.created_at', '>=', since)
    .executeTakeFirstOrThrow();
  return config.TENANT_DAILY_CRAWL_PAGE_LIMIT - Number(used.pages) - Number(reserved.pages);
}
