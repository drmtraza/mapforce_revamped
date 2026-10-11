import type { Tx } from '@mapforce/db';
import { AppError, notFound } from '../../errors.ts';
import { recordAudit } from '../audit/service.ts';

export async function acceptMatch(
  trx: Tx,
  input: {
    tenantId: string;
    userId: string;
    correlationId: string;
    matchId: string;
    survivorId: string;
  },
) {
  const match = await trx
    .selectFrom('match_candidates')
    .select(['id', 'person_a_id', 'person_b_id', 'status'])
    .where('tenant_id', '=', input.tenantId)
    .where('id', '=', input.matchId)
    .executeTakeFirst();
  if (!match) throw notFound('Match candidate');
  if (match.status !== 'proposed') {
    throw new AppError('INVALID_STATE', `Match is already ${match.status}.`);
  }
  const ids = [match.person_a_id, match.person_b_id];
  if (!ids.includes(input.survivorId)) {
    throw new AppError('VALIDATION_ERROR', 'Survivor must be one of the matched people.');
  }
  const absorbedId = ids.find((id) => id !== input.survivorId) as string;

  const people = await trx
    .selectFrom('people')
    .select(['id', 'canonical_name', 'merged_into_id'])
    .where('tenant_id', '=', input.tenantId)
    .where('id', 'in', ids)
    .execute();
  const survivor = people.find((p) => p.id === input.survivorId);
  const absorbed = people.find((p) => p.id === absorbedId);
  if (!survivor || !absorbed) throw notFound('Person');
  if (survivor.merged_into_id || absorbed.merged_into_id) {
    throw new AppError('INVALID_STATE', 'One of these people is already merged.');
  }

  await trx
    .updateTable('people')
    .set((eb) => ({ merged_into_id: survivor.id, version: eb('version', '+', 1) }))
    .where('tenant_id', '=', input.tenantId)
    .where('id', '=', absorbed.id)
    .execute();
  await trx
    .insertInto('person_aliases')
    .values({ tenant_id: input.tenantId, person_id: survivor.id, alias: absorbed.canonical_name })
    .onConflict((oc) => oc.columns(['tenant_id', 'person_id', 'alias']).doNothing())
    .execute();
  await trx
    .updateTable('match_candidates')
    .set({ status: 'accepted', resolved_at: new Date(), resolved_by: input.userId })
    .where('id', '=', match.id)
    .execute();
  const merge = await trx
    .insertInto('person_merges')
    .values({
      tenant_id: input.tenantId,
      survivor_id: survivor.id,
      absorbed_id: absorbed.id,
      match_candidate_id: match.id,
      actor_user_id: input.userId,
    })
    .returning(['id', 'survivor_id', 'absorbed_id'])
    .executeTakeFirstOrThrow();
  await recordAudit(trx, {
    tenantId: input.tenantId,
    actorUserId: input.userId,
    action: 'person.merged',
    entityType: 'person',
    entityId: survivor.id,
    correlationId: input.correlationId,
    metadata: { absorbed_id: absorbed.id, match_id: match.id, merge_id: merge.id },
  });
  return merge;
}

export async function splitMerge(
  trx: Tx,
  input: { tenantId: string; userId: string; correlationId: string; mergeId: string },
) {
  const merge = await trx
    .selectFrom('person_merges')
    .select(['id', 'survivor_id', 'absorbed_id', 'match_candidate_id', 'undone_at'])
    .where('tenant_id', '=', input.tenantId)
    .where('id', '=', input.mergeId)
    .executeTakeFirst();
  if (!merge) throw notFound('Person merge');
  if (merge.undone_at) throw new AppError('INVALID_STATE', 'This merge has already been split.');

  await trx
    .updateTable('people')
    .set((eb) => ({ merged_into_id: null, version: eb('version', '+', 1) }))
    .where('tenant_id', '=', input.tenantId)
    .where('id', '=', merge.absorbed_id)
    .execute();
  await trx
    .updateTable('person_merges')
    .set({ undone_at: new Date() })
    .where('id', '=', merge.id)
    .execute();
  if (merge.match_candidate_id) {
    await trx
      .updateTable('match_candidates')
      .set({ status: 'proposed', resolved_at: null, resolved_by: null })
      .where('id', '=', merge.match_candidate_id)
      .execute();
  }
  await recordAudit(trx, {
    tenantId: input.tenantId,
    actorUserId: input.userId,
    action: 'person.split',
    entityType: 'person',
    entityId: merge.survivor_id,
    correlationId: input.correlationId,
    metadata: { absorbed_id: merge.absorbed_id, merge_id: merge.id },
  });
  return { id: merge.id, survivor_id: merge.survivor_id, absorbed_id: merge.absorbed_id };
}
