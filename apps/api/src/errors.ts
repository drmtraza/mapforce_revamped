export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CSRF_REJECTED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'FEATURE_DISABLED'
  | 'INVALID_STATE'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  FEATURE_DISABLED: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown[];

  constructor(code: ErrorCode, message: string, details: unknown[] = []) {
    super(message);
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found.`);

export interface ErrorBody {
  error: { code: ErrorCode; message: string; correlation_id: string; details: unknown[] };
}

export function errorBody(err: AppError, correlationId: string): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      correlation_id: correlationId,
      details: err.details,
    },
  };
}
