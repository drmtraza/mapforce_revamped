import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withContext } from '@mapforce/db';
import type { AppDeps } from '../../app.ts';
import type { LoginChecks } from '../../auth/idp.ts';
import { createSession, revokeSession, SESSION_COOKIE, upsertUser } from '../../auth/sessions.ts';
import { requireUser } from '../../http/context.ts';
import { recordAudit } from '../audit/service.ts';

const LOGIN_COOKIE = 'mf_oidc';
const LOGIN_COOKIE_PATH = '/api/v1/auth';

export const authRoutes =
  (deps: AppDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { config, db, idp } = deps;
    const cookieBase = {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'lax' as const,
      signed: true,
    };

    app.get('/login', { schema: { hide: true } }, async (_request, reply) => {
      const { authorizationUrl, checks } = await idp.createLogin();
      reply.setCookie(LOGIN_COOKIE, JSON.stringify(checks), {
        ...cookieBase,
        path: LOGIN_COOKIE_PATH,
        maxAge: 600,
      });
      return reply.redirect(authorizationUrl, 302);
    });

    app.get('/callback', { schema: { hide: true } }, async (request, reply) => {
      const failure = new URL('/login?error=sign_in_failed', config.PUBLIC_WEB_ORIGIN).href;
      const raw = request.cookies[LOGIN_COOKIE];
      reply.clearCookie(LOGIN_COOKIE, { path: LOGIN_COOKIE_PATH });
      const unsigned = raw ? request.unsignCookie(raw) : null;
      if (!unsigned?.valid || !unsigned.value) return reply.redirect(failure, 302);

      try {
        const checks = JSON.parse(unsigned.value) as LoginChecks;
        const callbackUrl = new URL(config.OIDC_REDIRECT_URI);
        callbackUrl.search = new URL(request.url, 'http://placeholder').search;
        const identity = await idp.completeLogin(callbackUrl, checks);
        const userId = await upsertUser(db, identity);
        const session = await createSession(db, userId, config.SESSION_TTL_HOURS);
        await withContext(db, { tenantId: null, userId }, (trx) =>
          recordAudit(trx, {
            tenantId: null,
            actorUserId: userId,
            action: 'auth.sign_in',
            entityType: 'user',
            entityId: userId,
            correlationId: request.id,
          }),
        );
        reply.setCookie(SESSION_COOKIE, session.token, {
          ...cookieBase,
          path: '/',
          expires: session.expiresAt,
        });
        return reply.redirect(new URL('/workspaces', config.PUBLIC_WEB_ORIGIN).href, 302);
      } catch (err) {
        request.log.warn({ err }, 'sign-in failed');
        await withContext(db, { tenantId: null, userId: null }, (trx) =>
          recordAudit(trx, {
            tenantId: null,
            actorUserId: null,
            actorType: 'system',
            action: 'auth.sign_in',
            entityType: 'user',
            outcome: 'failure',
            correlationId: request.id,
          }),
        );
        return reply.redirect(failure, 302);
      }
    });

    app.post(
      '/logout',
      { schema: { tags: ['auth'], response: { 204: z.null() } } },
      async (request, reply) => {
        if (request.auth) {
          const { userId, sessionId } = request.auth;
          await revokeSession(db, sessionId);
          await withContext(db, { tenantId: null, userId }, (trx) =>
            recordAudit(trx, {
              tenantId: null,
              actorUserId: userId,
              action: 'auth.sign_out',
              entityType: 'user',
              entityId: userId,
              correlationId: request.id,
            }),
          );
        }
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.status(204).send(null);
      },
    );

    app.get(
      '/me',
      {
        schema: {
          tags: ['auth'],
          response: {
            200: z.object({
              user: z.object({
                id: z.string(),
                email: z.string(),
                display_name: z.string().nullable(),
              }),
            }),
          },
        },
      },
      async (request) => {
        const user = requireUser(request);
        return {
          user: {
            id: user.userId,
            email: user.email,
            display_name: request.auth?.displayName ?? null,
          },
        };
      },
    );
  };
