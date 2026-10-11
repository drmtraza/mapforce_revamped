import type { Tx } from '@mapforce/db';
import { hashContactValue } from '../contacts/crypto.ts';

export async function isDomainSuppressed(
  trx: Tx,
  tenantId: string,
  domain: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('consent_suppressions')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('subject_type', '=', 'domain')
    .where('value_hash', '=', hashContactValue('domain', domain))
    .executeTakeFirst();
  return Boolean(row);
}

export async function isPersonSuppressed(
  trx: Tx,
  tenantId: string,
  personId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('consent_suppressions')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('subject_type', '=', 'person')
    .where('value_hash', '=', hashContactValue('person', personId))
    .executeTakeFirst();
  return Boolean(row);
}
