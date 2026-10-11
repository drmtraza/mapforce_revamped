import { randomUUID } from 'node:crypto';
import type { Tx } from '@mapforce/db';

export type EventType =
  | 'research.company.requested'
  | 'discovery.source.completed'
  | 'crawl.evidence.created'
  | 'person.candidate.discovered'
  | 'research.job.completed'
  | 'discovery.search.requested'
  | 'discovery.job.completed'
  | 'company.import.completed'
  | 'enrichment.person.requested'
  | 'enrichment.job.completed'
  | 'orgmap.inference.requested'
  | 'orgmap.inference.completed';

export interface OutboxInput {
  tenantId: string;
  eventType: EventType;
  correlationId: string;
  idempotencyKey: string;
  causationId?: string | null;
  payload: Record<string, unknown>;
}

/** Writes an event in the same transaction as the state change; duplicates are ignored. */
export async function enqueueEvent(trx: Tx, e: OutboxInput): Promise<void> {
  await trx
    .insertInto('outbox_events')
    .values({
      id: randomUUID(),
      tenant_id: e.tenantId,
      event_type: e.eventType,
      schema_version: 1,
      correlation_id: e.correlationId,
      causation_id: e.causationId ?? null,
      idempotency_key: e.idempotencyKey,
      payload: JSON.stringify(e.payload),
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'event_type', 'idempotency_key']).doNothing())
    .execute();
}
