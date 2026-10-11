import type { paths } from './api-types';

type Method = 'get' | 'post' | 'patch' | 'delete';
type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;

/** Response body of the first 2xx status declared for `path` + `method`. */
export type ApiResponse<P extends keyof paths, M extends Method> = paths[P][M] extends {
  responses: infer R;
}
  ? R extends { 200: infer S }
    ? Json<S>
    : R extends { 201: infer S }
      ? Json<S>
      : R extends { 202: infer S }
        ? Json<S>
        : never
  : never;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | null;

  constructor(status: number, code: string, message: string, correlationId: string | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Sent verbatim instead of a JSON `body`, e.g. a CSV upload. */
  rawBody?: { contentType: string; text: string };
  workspaceId?: string;
  headers?: Record<string, string>;
}

/**
 * Same-origin call to the versioned API. The session cookie is httpOnly, so the browser
 * attaches it; the CSRF header marks the request as coming from this app.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (method !== 'GET') headers['x-mapforce-csrf'] = '1';
  if (opts.workspaceId) headers['x-workspace-id'] = opts.workspaceId;
  let body: string | undefined;
  if (opts.rawBody) {
    headers['content-type'] = opts.rawBody.contentType;
    body = opts.rawBody.text;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body !== undefined ? { body } : {}),
  });

  if (res.status === 204) return null as T;
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; correlation_id?: string } })
      ?.error;
    if (res.status === 401 && typeof window !== 'undefined') {
      window.location.assign('/login');
    }
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `Request failed (${res.status})`,
      err?.correlation_id ?? res.headers.get('x-correlation-id'),
    );
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.correlationId ? `${err.message} (reference ${err.correlationId})` : err.message;
  }
  return 'Something went wrong. Please try again.';
}
