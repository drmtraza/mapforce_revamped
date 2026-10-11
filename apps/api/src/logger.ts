import type { LoggerOptions } from 'pino';

/** Structured JSON logs; credentials, cookies and contact data are redacted. */
export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: { service: 'mapforce-api' },
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        '*.email',
        '*.password',
        '*.token',
        '*.secret',
      ],
      censor: '[redacted]',
    },
  };
}
