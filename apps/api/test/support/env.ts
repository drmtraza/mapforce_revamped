export function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_APP_URL: 'postgres://unused',
    SESSION_COOKIE_SECRET: 'test-only-cookie-secret-0123456789abcdef',
    OIDC_ISSUER_URL: 'http://idp.test/realms/mapforce',
    OIDC_CLIENT_ID: 'mapforce-web',
    OIDC_REDIRECT_URI: 'http://localhost:4000/api/v1/auth/callback',
    S3_ENDPOINT: 'http://storage.test',
    S3_PUBLIC_ENDPOINT: 'http://storage.test',
    S3_BUCKET: 'evidence',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test',
    CONTACT_FIELD_KEY: 'test-contact-field-key-not-for-production',
    ...overrides,
  };
}
