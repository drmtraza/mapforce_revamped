import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { sql, type Db } from '@mapforce/db';
import type { IdentityProvider } from './auth/idp.ts';
import { resolveSession, SESSION_COOKIE } from './auth/sessions.ts';
import type { Config } from './config.ts';
import { AppError, errorBody } from './errors.ts';
import { loggerOptions } from './logger.ts';
import type { EvidenceStorage } from './modules/evidence/storage.ts';
import type { ResearchDispatcher } from './temporal/dispatcher.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { workspaceRoutes } from './modules/workspaces/routes.ts';
import { icpRoutes } from './modules/icp/routes.ts';
import { companyRoutes } from './modules/companies/routes.ts';
import { evidenceRoutes } from './modules/evidence/routes.ts';
import { researchRoutes } from './modules/research/routes.ts';
import { peopleRoutes } from './modules/people/routes.ts';
import { orgMapRoutes } from './modules/orgmap/routes.ts';
import { auditRoutes } from './modules/audit/routes.ts';
import { sourceRoutes } from './modules/sources/routes.ts';
import { discoveryRoutes } from './modules/discovery/routes.ts';
import { importRoutes } from './modules/imports/routes.ts';
import { deadLetterRoutes } from './modules/outbox/routes.ts';
import { signalRoutes } from './modules/signals/routes.ts';
import { suppressionRoutes } from './modules/suppressions/routes.ts';
import { enrichmentRoutes } from './modules/enrichment/routes.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  idp: IdentityProvider;
  storage: EvidenceStorage;
  dispatcher: ResearchDispatcher;
  redis?: Redis;
  logger?: boolean;
}

const CORRELATION_RE = /^[A-Za-z0-9._-]{8,64}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-mapforce-csrf';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: deps.logger === false ? false : loggerOptions(config.LOG_LEVEL),
    bodyLimit: 256 * 1024,
    trustProxy: config.NODE_ENV === 'production',
    genReqId: (req) => {
      const h = req.headers['x-correlation-id'];
      return typeof h === 'string' && CORRELATION_RE.test(h) ? h : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('auth', null);

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: config.NODE_ENV === 'production',
  });
  await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    ...(deps.redis ? { redis: deps.redis } : {}),
    keyGenerator: (req) => req.auth?.userId ?? req.ip,
    errorResponseBuilder: (req) => ({
      statusCode: 429,
      ...errorBody(new AppError('RATE_LIMITED', 'Too many requests.'), req.id),
    }),
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Mapforce API', version: '1.0.0' },
      components: {
        securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } },
      },
    },
    transform: jsonSchemaTransform,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
    if (!SAFE_METHODS.has(request.method) && request.headers[CSRF_HEADER] !== '1') {
      throw new AppError('CSRF_REJECTED', 'Missing CSRF protection header.');
    }
    const raw = request.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        request.auth = await resolveSession(deps.db, unsigned.value);
      }
    }
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    let appErr: AppError;
    if (err instanceof AppError) {
      appErr = err;
    } else if (hasZodFastifySchemaValidationErrors(err)) {
      appErr = new AppError(
        'VALIDATION_ERROR',
        'The request could not be processed.',
        err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      );
    } else if (err.statusCode === 429) {
      appErr = new AppError('RATE_LIMITED', 'Too many requests.');
    } else if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      appErr = new AppError('VALIDATION_ERROR', 'The request could not be processed.');
      return reply.status(err.statusCode).send(errorBody(appErr, request.id));
    } else {
      request.log.error({ err }, 'unhandled error');
      appErr = new AppError('INTERNAL_ERROR', 'An unexpected error occurred.');
    }
    return reply.status(appErr.statusCode).send(errorBody(appErr, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(errorBody(new AppError('NOT_FOUND', 'Route not found.'), request.id));
  });

  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await sql`SELECT 1`.execute(deps.db);
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  await app.register(
    async (v1) => {
      v1.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
      await v1.register(authRoutes(deps), { prefix: '/auth' });
      await v1.register(workspaceRoutes(deps));
      await v1.register(icpRoutes(deps));
      await v1.register(companyRoutes(deps));
      await v1.register(evidenceRoutes(deps));
      await v1.register(researchRoutes(deps));
      await v1.register(peopleRoutes(deps));
      await v1.register(orgMapRoutes(deps));
      await v1.register(auditRoutes(deps));
      await v1.register(sourceRoutes(deps));
      await v1.register(discoveryRoutes(deps));
      await v1.register(importRoutes(deps));
      await v1.register(deadLetterRoutes(deps));
      await v1.register(signalRoutes(deps));
      await v1.register(suppressionRoutes(deps));
      await v1.register(enrichmentRoutes(deps));
    },
    { prefix: '/api/v1' },
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
