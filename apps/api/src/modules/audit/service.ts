import type { Tx } from '@mapforce/db';

export interface AuditInput {
  tenantId: string | null;
  actorUserId: string | null;
  actorType?: 'user' | 'system';
  action: string;
  entityType: string;
  entityId?: string | null;
  outcome?: 'success' | 'denied' | 'failure';
  correlationId: string;
  metadata?: Record<string, unknown>;
}

/** Appends an audit event inside the caller's transaction so it commits atomically with the change. */
export async function recordAudit(trx: Tx, e: AuditInput): Promise<void> {
  await trx
    .insertInto('audit_events')
    .values({
      tenant_id: e.tenantId,
      actor_user_id: e.actorUserId,
      actor_type: e.actorType ?? (e.actorUserId ? 'user' : 'system'),
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId ?? null,
      outcome: e.outcome ?? 'success',
      correlation_id: e.correlationId,
      metadata: JSON.stringify(e.metadata ?? {}),
    })
    .execute();
}
