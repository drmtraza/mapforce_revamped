import type { Tx } from '@mapforce/db';
import { AppError } from '../../errors.ts';
import type { TenantCtx } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';

export const ACTIVE_JOB_STATUSES = ['queued', 'running', 'cancel_requested'] as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

export function parseIdempotencyKey(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY.test(header)) {
    throw new AppError('VALIDATION_ERROR', 'Invalid Idempotency-Key header.');
  }
  return header;
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** Research and discovery jobs share one rolling 24 h limit per workspace. */
export async function dailyJobQuotaExceeded(
  trx: Tx,
  ctx: TenantCtx,
  limit: number,
  entity: { action: string; type: string; id: string | null },
): Promise<boolean> {
  const today = await trx
    .selectFrom('workflow_jobs')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', ctx.tenantId)
    .where('created_at', '>=', new Date(Date.now() - 86_400_000))
    .executeTakeFirstOrThrow();
  if (Number(today.n) < limit) return false;
  await recordAudit(trx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: entity.action,
    entityType: entity.type,
    entityId: entity.id,
    outcome: 'denied',
    correlationId: ctx.correlationId,
  });
  return true;
}
