import { createHash, randomBytes } from 'node:crypto';
import { sql, withContext, type Db } from '@mapforce/db';
import type { VerifiedIdentity } from './idp.ts';

export const SESSION_COOKIE = 'mf_session';

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string | null;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest();

export async function upsertUser(db: Db, identity: VerifiedIdentity): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT app_upsert_user_from_idp(${identity.issuer}, ${identity.subject},
                                    ${identity.email}, ${identity.displayName}) AS id`.execute(db);
  const id = rows[0]?.id;
  if (!id) throw new Error('User upsert returned no id');
  return id;
}

export async function createSession(
  db: Db,
  userId: string,
  ttlHours: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await db
    .insertInto('sessions')
    .values({ token_hash: hashToken(token), user_id: userId, expires_at: expiresAt })
    .execute();
  return { token, expiresAt };
}

export async function resolveSession(db: Db, token: string): Promise<SessionUser | null> {
  if (token.length < 20 || token.length > 100) return null;
  const session = await db
    .selectFrom('sessions')
    .select(['id', 'user_id', 'last_seen_at'])
    .where('token_hash', '=', hashToken(token))
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  if (!session) return null;

  const user = await withContext(db, { tenantId: null, userId: session.user_id }, (trx) =>
    trx
      .selectFrom('users')
      .select(['id', 'email', 'display_name', 'status'])
      .where('id', '=', session.user_id)
      .executeTakeFirst(),
  );
  if (!user || user.status !== 'active') return null;

  if (Date.now() - session.last_seen_at.getTime() > 60_000) {
    await db
      .updateTable('sessions')
      .set({ last_seen_at: new Date() })
      .where('id', '=', session.id)
      .execute();
  }
  return {
    sessionId: session.id,
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
  };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ revoked_at: new Date() })
    .where('id', '=', sessionId)
    .execute();
}
