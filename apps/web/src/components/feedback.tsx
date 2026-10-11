import type { ReactNode } from 'react';
import { errorMessage } from '@/lib/api';

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="notice notice-error">
      {errorMessage(error)}
    </p>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" className="muted">
      {label}…
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted empty">{children}</p>;
}
