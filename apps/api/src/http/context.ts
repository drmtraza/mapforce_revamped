import type { FastifyRequest } from 'fastify';
import { withContext, type Db, type MembershipRole } from '@mapforce/db';
import type { SessionUser } from '../auth/sessions.ts';
import { AppError, notFound } from '../errors.ts';
import { recordAudit } from '../modules/audit/service.ts';
import { can, type Permission } from '../rbac.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: SessionUser | null;
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WORKSPACE_HEADER = 'x-workspace-id';

export interface UserCtx {
  userId: string;
  email: string;
  correlationId: string;
}

export interface TenantCtx extends UserCtx {
  tenantId: string;
  role: MembershipRole;
}

export function requireUser(request: FastifyRequest): UserCtx {
  if (!request.auth) throw new AppError('UNAUTHENTICATED', 'Sign in required.');
  return { userId: request.auth.userId, email: request.auth.email, correlationId: request.id };
}

/**
 * Resolves the active workspace from the X-Workspace-Id header, verifies active
 * membership and the requested permission. Non-members get 404 (no existence oracle).
 */
export async function requireTenant(
  db: Db,
  request: FastifyRequest,
  permission: Permission,
): Promise<TenantCtx> {
  const user = requireUser(request);
  const header = request.headers[WORKSPACE_HEADER];
  if (typeof header !== 'string' || !UUID_RE.test(header)) {
    throw new AppError('VALIDATION_ERROR', 'A valid X-Workspace-Id header is required.');
  }
  const tenantId = header.toLowerCase();
  const membership = await withContext(db, { tenantId, userId: user.userId }, (trx) =>
    trx
      .selectFrom('memberships')
      .select(['role', 'status'])
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', user.userId)
      .executeTakeFirst(),
  );
  if (!membership || membership.status !== 'active') throw notFound('Workspace');

  if (!can(membership.role, permission)) {
    await withContext(db, { tenantId, userId: user.userId }, (trx) =>
      recordAudit(trx, {
        tenantId,
        actorUserId: user.userId,
        action: 'authz.denied',
        entityType: 'permission',
        entityId: permission,
        outcome: 'denied',
        correlationId: user.correlationId,
        metadata: { role: membership.role, route: request.routeOptions.url },
      }),
    );
    throw new AppError('FORBIDDEN', 'Your role does not permit this action.');
  }
  return { ...user, tenantId, role: membership.role };
}
