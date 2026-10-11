'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { api, type ApiResponse } from '@/lib/api';
import { useApi } from '@/lib/use-api';

type Me = ApiResponse<'/api/v1/auth/me', 'get'>;

export function AppHeader({ children }: { children?: ReactNode }) {
  const me = useApi<Me>('/api/v1/auth/me');

  async function signOut() {
    try {
      await api('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      window.location.assign('/login');
    }
  }

  return (
    <header className="app-header">
      <Link href="/workspaces" className="brand">
        Mapforce
      </Link>
      {children}
      <div className="header-user">
        {me.data ? <span className="muted">{me.data.user.email}</span> : null}
        <button type="button" className="button button-quiet" onClick={signOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
