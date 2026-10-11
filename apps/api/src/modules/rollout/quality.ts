import type { Tx } from '@mapforce/db';

/** Tenant-local data-quality snapshot for beta review — no contact values. */
export async function dataQualityReport(trx: Tx, tenantId: string) {
  const people = await trx
    .selectFrom('people')
    .select(['review_status', (eb) => eb.fn.countAll<string>().as('n')])
    .where('tenant_id', '=', tenantId)
    .where('merged_into_id', 'is', null)
    .groupBy('review_status')
    .execute();
  const byReview = Object.fromEntries(people.map((p) => [p.review_status, Number(p.n)]));
  const quarantine = await trx
    .selectFrom('ai_quarantine')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', tenantId)
    .executeTakeFirstOrThrow();
  const suppressions = await trx
    .selectFrom('consent_suppressions')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', tenantId)
    .executeTakeFirstOrThrow();
  const disputedClaims = await trx
    .selectFrom('claims')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'disputed')
    .executeTakeFirstOrThrow();
  const openFeedback = await trx
    .selectFrom('feedback_items')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'open')
    .executeTakeFirstOrThrow();
  const openIncidents = await trx
    .selectFrom('incident_triage_notes')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('status', '!=', 'resolved')
    .executeTakeFirstOrThrow();
  return {
    people: {
      unreviewed: byReview.unreviewed ?? 0,
      accepted: byReview.accepted ?? 0,
      rejected: byReview.rejected ?? 0,
      disputed: byReview.disputed ?? 0,
    },
    ai_quarantine: Number(quarantine.n),
    disputed_claims: Number(disputedClaims.n),
    suppressions: Number(suppressions.n),
    open_feedback: Number(openFeedback.n),
    open_incidents: Number(openIncidents.n),
    note: 'Counts only. Contact values and evidence excerpts are omitted.',
  };
}
