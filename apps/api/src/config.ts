import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .default(false);

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    PUBLIC_WEB_ORIGIN: z.url().default('http://localhost:3000'),

    DATABASE_APP_URL: z.string().min(1),
    DATABASE_RELAY_URL: z.string().min(1).optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

    REDIS_URL: z.string().optional(),

    SESSION_COOKIE_SECRET: z
      .string()
      .min(32, 'SESSION_COOKIE_SECRET must be at least 32 characters'),
    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 14)
      .default(8),
    COOKIE_SECURE: bool,

    OIDC_ISSUER_URL: z.url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_REDIRECT_URI: z.url(),
    OIDC_ALLOW_INSECURE_HTTP: bool,

    S3_ENDPOINT: z.url(),
    S3_PUBLIC_ENDPOINT: z.url(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: bool,
    EVIDENCE_URL_TTL_SECONDS: z.coerce.number().int().min(10).max(900).default(60),

    TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    TEMPORAL_TASK_QUEUE: z.string().default('research-control'),
    RESEARCH_PYTHON_TASK_QUEUE: z.string().default('research-python'),

    TENANT_DAILY_RESEARCH_JOB_LIMIT: z.coerce.number().int().min(1).max(100_000).default(100),
    TENANT_DAILY_CRAWL_PAGE_LIMIT: z.coerce.number().int().min(0).max(1_000_000).default(200),
    TENANT_DAILY_ENRICH_LIMIT: z.coerce.number().int().min(0).max(100_000).default(50),
    CONTACT_FIELD_KEY: z.string().min(32, 'CONTACT_FIELD_KEY must be at least 32 characters'),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),
    FEATURE_MOCK_PROVIDERS: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .default(true),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production') {
      if (!c.COOKIE_SECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['COOKIE_SECURE'],
          message: 'must be true in production',
        });
      }
      if (c.OIDC_ALLOW_INSECURE_HTTP) {
        ctx.addIssue({
          code: 'custom',
          path: ['OIDC_ALLOW_INSECURE_HTTP'],
          message: 'must be false in production',
        });
      }
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
