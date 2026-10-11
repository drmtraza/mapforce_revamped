'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AppHeader } from '@/components/app-header';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api, type ApiResponse } from '@/lib/api';
import { useApi } from '@/lib/use-api';

type Workspaces = ApiResponse<'/api/v1/workspaces', 'get'>;
type Workspace = ApiResponse<'/api/v1/workspaces', 'post'>;

export default function WorkspacesPage() {
  const router = useRouter();
  const list = useApi<Workspaces>('/api/v1/workspaces');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ws = await api<Workspace>('/api/v1/workspaces', {
        method: 'POST',
        body: { name: name.trim() },
      });
      router.push(`/w/${ws.id}/companies`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <>
      <AppHeader />
      <main id="main" className="page">
        <h1>Workspaces</h1>
        <section aria-labelledby="ws-list" className="card">
          <h2 id="ws-list">Your workspaces</h2>
          {list.loading ? <Loading /> : null}
          <ErrorNotice error={list.error} />
          {list.data && list.data.data.length === 0 ? (
            <Empty>You are not a member of any workspace yet. Create one below.</Empty>
          ) : null}
          <ul className="list">
            {list.data?.data.map((w) => (
              <li key={w.id}>
                <Link href={`/w/${w.id}/companies`}>{w.name}</Link>
                <span className="muted"> · {w.role}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="ws-create" className="card">
          <h2 id="ws-create">Create a workspace</h2>
          <form onSubmit={create} className="form-row">
            <label htmlFor="ws-name">Workspace name</label>
            <input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              autoComplete="organization"
            />
            <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create workspace'}
            </button>
          </form>
          <ErrorNotice error={error} />
        </section>
      </main>
    </>
  );
}
