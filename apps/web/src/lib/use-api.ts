'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

interface State<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
}

/** Loads `path` (scoped to a workspace) and exposes a `reload` for after mutations. */
export function useApi<T>(path: string | null, workspaceId?: string) {
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) return;
    let active = true;
    api<T>(path, workspaceId ? { workspaceId } : {})
      .then((data) => active && setState({ data, error: null, loading: false }))
      .catch((error: unknown) => active && setState({ data: null, error, loading: false }));
    return () => {
      active = false;
    };
  }, [path, workspaceId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
