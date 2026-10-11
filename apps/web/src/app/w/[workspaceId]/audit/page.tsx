'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { StatusBadge } from '@/components/badges';
import { formatDate } from '@/components/evidence-list';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api, type ApiResponse } from '@/lib/api';
import { useApi } from '@/lib/use-api';

type Audit = ApiResponse<'/api/v1/audit-events', 'get'>;

const PATH = '/api/v1/audit-events?limit=50';

export default function AuditPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const first = useApi<Audit>(PATH, workspaceId);
  const [extra, setExtra] = useState<Audit['data']>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);

  async function loadMore() {
    const next = cursor === undefined ? first.data?.next_cursor : cursor;
    if (!next) return;
    try {
      const page = await api<Audit>(`${PATH}&cursor=${encodeURIComponent(next)}`, {
        workspaceId,
      });
      setExtra((rows) => [...rows, ...page.data]);
      setCursor(page.next_cursor);
    } catch (err) {
      setError(err);
    }
  }

  const rows = [...(first.data?.data ?? []), ...extra];
  const hasMore = cursor === undefined ? (first.data?.has_more ?? false) : cursor !== null;

  return (
    <>
      <h1>Audit trail</h1>
      <section className="card" aria-label="Audit events">
        <p className="muted small">
          Append-only record of sign-ins, changes, research runs, evidence access and denied
          requests in this workspace.
        </p>
        {first.loading ? <Loading /> : null}
        <ErrorNotice error={first.error ?? error} />
        {first.data && rows.length === 0 ? <Empty>No events yet.</Empty> : null}
        {rows.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Actor</th>
                <th scope="col">Entity</th>
                <th scope="col">Outcome</th>
                <th scope="col">Reference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>{formatDate(e.created_at)}</td>
                  <td>
                    <code>{e.action}</code>
                  </td>
                  <td>
                    {e.actor_type === 'user' && e.actor_user_id
                      ? `user ${e.actor_user_id.slice(0, 8)}`
                      : e.actor_type}
                  </td>
                  <td>
                    {e.entity_type}
                    {e.entity_id ? (
                      <span className="muted small"> {e.entity_id.slice(0, 8)}</span>
                    ) : null}
                  </td>
                  <td>
                    <StatusBadge status={e.outcome} />
                  </td>
                  <td className="muted small">
                    <code>{e.correlation_id.slice(0, 12)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {hasMore ? (
          <button type="button" className="button" onClick={loadMore}>
            Load older events
          </button>
        ) : null}
      </section>
    </>
  );
}
