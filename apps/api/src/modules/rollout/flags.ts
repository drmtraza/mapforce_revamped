import type { Tx } from '@mapforce/db';

export async function listFlags(trx: Tx, tenantId: string) {
  const globals = await trx.selectFrom('feature_flags').selectAll().orderBy('key').execute();
  const overrides = await trx
    .selectFrom('tenant_feature_overrides')
    .select(['flag_key', 'enabled'])
    .where('tenant_id', '=', tenantId)
    .execute();
  const byKey = new Map(overrides.map((o) => [o.flag_key, o.enabled]));
  return globals.map((g) => ({
    key: g.key,
    description: g.description,
    global_enabled: g.enabled,
    tenant_override: byKey.has(g.key) ? byKey.get(g.key)! : null,
    effective: byKey.has(g.key) ? byKey.get(g.key)! : g.enabled,
  }));
}

export async function isFlagEnabled(trx: Tx, tenantId: string, key: string): Promise<boolean> {
  const global = await trx
    .selectFrom('feature_flags')
    .select('enabled')
    .where('key', '=', key)
    .executeTakeFirst();
  if (!global) return false;
  const override = await trx
    .selectFrom('tenant_feature_overrides')
    .select('enabled')
    .where('tenant_id', '=', tenantId)
    .where('flag_key', '=', key)
    .executeTakeFirst();
  return override ? override.enabled : global.enabled;
}
