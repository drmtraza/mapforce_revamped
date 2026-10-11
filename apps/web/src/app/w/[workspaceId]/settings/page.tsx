'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { MockBadge, StatusBadge } from '@/components/badges';
import { formatDate } from '@/components/evidence-list';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api, type ApiResponse } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type Sources = ApiResponse<'/api/v1/sources', 'get'>;
type DeadLetters = ApiResponse<'/api/v1/dead-letters', 'get'>;
type Source = Sources['data'][number];

export default function SettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const role = useWorkspaceRole(workspaceId);
  const sources = useApi<Sources>('/api/v1/sources', workspaceId);
  const letters = useApi<DeadLetters>('/api/v1/dead-letters?limit=50', workspaceId);
  const canManageSources = allowed(role, 'manageSources');
  const canReplay = allowed(role, 'manageDeadLetters');
  const [error, setError] = useState<unknown>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function toggle(s: Source, enabled: boolean) {
    setBusyKey(s.id);
    setError(null);
    try {
      await api(`/api/v1/sources/${s.id}`, {
        method: 'PATCH',
        workspaceId,
        body: { enabled },
      });
      sources.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusyKey(null);
    }
  }

  async function replay(id: string) {
    setBusyKey(id);
    setError(null);
    try {
      await api(`/api/v1/dead-letters/${id}/replay`, { method: 'POST', workspaceId });
      letters.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <>
      <h1>Workspace settings</h1>

      <section aria-labelledby="sources" className="card">
        <h2 id="sources">Sources</h2>
        <p className="muted small">
          The platform owner controls the global kill switch. Workspace owners and admins opt in to
          sources that are off by default (the public company-site crawler). Brave Search stays
          unavailable until an operator enables it and supplies an API key.
        </p>
        {sources.loading ? <Loading /> : null}
        <ErrorNotice error={sources.error ?? error} />
        {sources.data ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Type</th>
                <th scope="col">Availability</th>
                <th scope="col">This workspace</th>
              </tr>
            </thead>
            <tbody>
              {sources.data.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.provider_name}</strong> {s.is_mock ? <MockBadge /> : null}
                    <p className="muted small">{s.description}</p>
                    <p className="muted small">Terms: {s.terms_reference}</p>
                  </td>
                  <td>{s.source_type.replace(/_/g, ' ')}</td>
                  <td>
                    {s.available ? (
                      <StatusBadge status="available" />
                    ) : (
                      <span className="muted small">{s.unavailable_reason ?? 'Unavailable'}</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={s.tenant_setting} />
                    {canManageSources && s.globally_enabled ? (
                      <div className="actions">
                        <button
                          type="button"
                          className="button"
                          disabled={busyKey === s.id || s.tenant_enabled}
                          onClick={() => toggle(s, true)}
                        >
                          Enable
                        </button>
                        <button
                          type="button"
                          className="button"
                          disabled={busyKey === s.id || !s.tenant_enabled}
                          onClick={() => toggle(s, false)}
                        >
                          Disable
                        </button>
                      </div>
                    ) : null}
                    {!s.globally_enabled ? (
                      <p className="muted small">Disabled by the platform owner.</p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section aria-labelledby="dlq" className="card">
        <h2 id="dlq">Dead-lettered events</h2>
        <p className="muted small">
          Events that could not be delivered after ten attempts. Replaying resets the attempt
          counter; the payload is not shown here.
        </p>
        {letters.loading ? <Loading /> : null}
        <ErrorNotice error={letters.error} />
        {letters.data && letters.data.data.length === 0 ? (
          <Empty>No dead-lettered events.</Empty>
        ) : null}
        {letters.data && letters.data.data.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Type</th>
                <th scope="col">Attempts</th>
                <th scope="col">Last error</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {letters.data.data.map((e) => (
                <tr key={e.id}>
                  <td>{formatDate(e.dead_lettered_at)}</td>
                  <td>
                    <code>{e.event_type}</code>
                  </td>
                  <td>{e.attempts}</td>
                  <td className="muted small">{e.last_error}</td>
                  <td>
                    {canReplay ? (
                      <button
                        type="button"
                        className="button"
                        disabled={busyKey === e.id}
                        onClick={() => replay(e.id)}
                      >
                        Replay
                      </button>
                    ) : (
                      <span className="muted">Owner or admin only</span>
                    )}
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
