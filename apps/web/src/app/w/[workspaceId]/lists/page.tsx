'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { StatusBadge } from '@/components/badges';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type ListRow = {
  id: string;
  name: string;
  kind: 'companies' | 'people';
  item_count: number;
  created_at: string;
};

export default function ListsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const role = useWorkspaceRole(workspaceId);
  const lists = useApi<{ data: ListRow[] }>('/api/v1/lists', workspaceId);
  const canWrite = allowed(role, 'writeLists');
  const canExport = allowed(role, 'startExport');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'companies' | 'people'>('companies');
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/v1/lists', {
        method: 'POST',
        workspaceId,
        body: { name, kind },
      });
      setName('');
      lists.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function exportList(id: string) {
    setError(null);
    setNote(null);
    try {
      const res = await api<{ filename: string; csv: string; omitted_suppressed: number }>(
        '/api/v1/exports',
        { method: 'POST', workspaceId, body: { scope: 'list', list_id: id } },
      );
      const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
      setNote(`Exported. ${res.omitted_suppressed} suppressed row(s) omitted.`);
    } catch (err) {
      setError(err);
    }
  }

  if (lists.loading && !lists.data) return <Loading />;

  return (
    <>
      <h1>Lists</h1>
      <p className="muted small">
        Suppression blocks add and export. CSV export prefixes formula-like cells and never includes
        contact values.
      </p>
      <ErrorNotice error={lists.error ?? error} />
      {note ? <p className="notice">{note}</p> : null}

      {canWrite ? (
        <form className="card" onSubmit={create}>
          <h2>New list</h2>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
            />
          </label>
          <label>
            Kind
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as 'companies' | 'people')}
            >
              <option value="companies">Companies</option>
              <option value="people">People</option>
            </select>
          </label>
          <button type="submit" className="button button-primary">
            Create list
          </button>
        </form>
      ) : null}

      <section className="card" aria-labelledby="saved">
        <h2 id="saved">Saved lists</h2>
        {lists.data && lists.data.data.length === 0 ? <Empty>No lists yet.</Empty> : null}
        {lists.data && lists.data.data.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">Items</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {lists.data.data.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link href={`/w/${workspaceId}/lists/${l.id}`}>{l.name}</Link>
                  </td>
                  <td>
                    <StatusBadge status={l.kind} />
                  </td>
                  <td>{l.item_count}</td>
                  <td>
                    {canExport ? (
                      <button type="button" className="button" onClick={() => exportList(l.id)}>
                        Export CSV
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}
