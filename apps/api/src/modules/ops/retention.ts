import type { Tx } from '@mapforce/db';

export const RETENTION_SWEEP_LIMIT = 100;

export async function retentionReport(trx: Tx, tenantId: string) {
  const now = new Date();
  const evidence = await trx
    .selectFrom('evidence_records')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('retention_until', 'is not', null)
    .where('retention_until', '<', now)
    .where('excerpt', 'is not', null)
    .executeTakeFirstOrThrow();
  const suppressions = await trx
    .selectFrom('consent_suppressions')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', tenantId)
    .executeTakeFirstOrThrow();
  return {
    expired_evidence_with_excerpt: Number(evidence.n),
    suppression_hashes_retained: Number(suppressions.n),
    note: 'Sweep redacts expired evidence excerpts only. Suppression hashes are kept so suppressed contacts are not re-imported.',
  };
}

/** Redact expired excerpts. Does not delete hashes, contacts or suppression rows. */
export async function sweepExpiredEvidence(trx: Tx, tenantId: string) {
  const expired = await trx
    .selectFrom('evidence_records')
    .select(['id'])
    .where('tenant_id', '=', tenantId)
    .where('retention_until', 'is not', null)
    .where('retention_until', '<', new Date())
    .where('excerpt', 'is not', null)
    .limit(RETENTION_SWEEP_LIMIT)
    .execute();
  if (expired.length === 0) return { redacted: 0 };
  await trx
    .updateTable('evidence_records')
    .set({ excerpt: null })
    .where('tenant_id', '=', tenantId)
    .where(
      'id',
      'in',
      expired.map((r) => r.id),
    )
    .execute();
  return { redacted: expired.length };
}
