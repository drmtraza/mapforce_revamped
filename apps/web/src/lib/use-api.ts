'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type ApiResponse } from './api';

type Workspaces = ApiResponse<'/api/v1/workspaces', 'get'>;
export type WorkspaceRole = Workspaces['data'][number]['role'];

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

/**
 * The caller's role in the workspace, used only to hide controls they cannot use. The API
 * enforces every permission regardless.
 */
export function useWorkspaceRole(workspaceId: string): WorkspaceRole | null {
  const { data } = useApi<Workspaces>('/api/v1/workspaces');
  return data?.data.find((w) => w.id === workspaceId)?.role ?? null;
}
