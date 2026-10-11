import { z } from 'zod';
import { AppError } from '../errors.ts';
import { UUID_RE } from './context.ts';

export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface Cursor {
  t: string;
  id: string;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      typeof parsed.t === 'string' &&
      !Number.isNaN(Date.parse(parsed.t)) &&
      typeof parsed.id === 'string' &&
      UUID_RE.test(parsed.id)
    ) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // fall through
  }
  throw new AppError('VALIDATION_ERROR', 'Invalid pagination cursor.');
}

/** Given limit+1 rows ordered newest first, returns the page and the next cursor. */
export function paginate<T extends { created_at: Date; id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    page,
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

export const PageMeta = {
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
};
