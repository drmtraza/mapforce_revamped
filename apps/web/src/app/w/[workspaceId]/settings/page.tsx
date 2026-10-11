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
type Suppressions = ApiResponse<'/api/v1/suppressions', 'get'>;
type Source = Sources['data'][number];

export default function SettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const role = useWorkspaceRole(workspaceId);
  const sources = useApi<Sources>('/api/v1/sources', workspaceId);
  const letters = useApi<DeadLetters>('/api/v1/dead-letters?limit=50', workspaceId);
  const suppressions = useApi<Suppressions>('/api/v1/suppressions', workspaceId);
  const canManageSources = allowed(role, 'manageSources');
  const canReplay = allowed(role, 'manageDeadLetters');
  const canSuppress = allowed(role, 'writeSuppression');
  const [suppressType, setSuppressType] = useState<'email' | 'phone' | 'domain'>('email');
  const [suppressValue, setSuppressValue] = useState('');
  const [suppressReason, setSuppressReason] = useState('');
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
          sources that are off by default (the public company-site crawler). Brave Search and the
          licensed contact provider stay unavailable until an operator enables them and supplies
          credentials (D12 / D14).
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

      <section aria-labelledby="suppressions" className="card">
        <h2 id="suppressions">Suppression list</h2>
        <p className="muted small">
          Suppressed addresses, phones and domains override enrichment, export and outreach. Values
          are stored as hashes; only a hint is shown.
        </p>
        {canSuppress ? (
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                await api('/api/v1/suppressions', {
                  method: 'POST',
                  workspaceId,
                  body: {
                    subject_type: suppressType,
                    value: suppressValue.trim(),
                    ...(suppressReason.trim() ? { reason: suppressReason.trim() } : {}),
                  },
                });
                setSuppressValue('');
                setSuppressReason('');
                suppressions.reload();
              } catch (err) {
                setError(err);
              }
            }}
          >
            <label htmlFor="suppress-type">Subject</label>
            <select
              id="suppress-type"
              value={suppressType}
              onChange={(e) => setSuppressType(e.target.value as 'email' | 'phone' | 'domain')}
            >
              <option value="email">Email</option>
              <option value="phone">Phone</option>
              <option value="domain">Domain</option>
            </select>
            <label htmlFor="suppress-value">Value</label>
            <input
              id="suppress-value"
              value={suppressValue}
              onChange={(e) => setSuppressValue(e.target.value)}
              required
            />
            <label htmlFor="suppress-reason">Reason (optional)</label>
            <input
              id="suppress-reason"
              value={suppressReason}
              onChange={(e) => setSuppressReason(e.target.value)}
            />
            <button type="submit" className="button button-primary">
              Add suppression
            </button>
          </form>
        ) : null}
        <ErrorNotice error={suppressions.error} />
        {suppressions.data && suppressions.data.data.length === 0 ? (
          <Empty>No suppressions.</Empty>
        ) : null}
        {suppressions.data && suppressions.data.data.length > 0 ? (
          <ul className="list">
            {suppressions.data.data.map((s) => (
              <li key={s.id}>
                {s.subject_type} · {s.display_hint}
                {s.reason ? <span className="muted"> · {s.reason}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <UsageBudget workspaceId={workspaceId} role={role} />
      <OpsPanel workspaceId={workspaceId} role={role} />
    </>
  );
}

function UsageBudget({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: ReturnType<typeof useWorkspaceRole>;
}) {
  const usage = useApi<{
    jobs: Record<string, number>;
    exports: number;
    ai_tokens: number;
    limits: { research: number; enrich: number; ai: number; export: number };
    note: string;
  }>('/api/v1/usage', workspaceId);
  const budget = useApi<{
    daily_export_limit: number | null;
    effective: { export: number };
  }>('/api/v1/workspace-budget', workspaceId);
  const [exportLimit, setExportLimit] = useState('');
  const [error, setError] = useState<unknown>(null);

  return (
    <section aria-labelledby="usage" className="card">
      <h2 id="usage">Usage and budgets</h2>
      <p className="muted small">
        Last 24 hours. Billing/plan integration is not enabled; these are workspace meters and admin
        overrides.
      </p>
      <ErrorNotice error={usage.error ?? budget.error ?? error} />
      {usage.data ? (
        <dl className="facts">
          <dt>Research jobs</dt>
          <dd>
            {usage.data.jobs.company_research} / {usage.data.limits.research}
          </dd>
          <dt>Enrich jobs</dt>
          <dd>
            {usage.data.jobs.person_enrichment} / {usage.data.limits.enrich}
          </dd>
          <dt>AI org-map jobs</dt>
          <dd>
            {usage.data.jobs.company_orgmap} / {usage.data.limits.ai}
          </dd>
          <dt>Exports</dt>
          <dd>
            {usage.data.exports} / {usage.data.limits.export}
          </dd>
          <dt>AI tokens</dt>
          <dd>{usage.data.ai_tokens}</dd>
        </dl>
      ) : null}
      {allowed(role, 'manageBudget') ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await api('/api/v1/workspace-budget', {
                method: 'PATCH',
                workspaceId,
                body: {
                  daily_export_limit: exportLimit.trim() === '' ? null : Number(exportLimit),
                },
              });
              budget.reload();
              usage.reload();
            } catch (err) {
              setError(err);
            }
          }}
        >
          <label>
            Daily export limit override (blank = default {budget.data?.effective.export ?? 20})
            <input
              inputMode="numeric"
              value={exportLimit}
              onChange={(e) => setExportLimit(e.target.value)}
            />
          </label>
          <button type="submit" className="button">
            Save budget override
          </button>
        </form>
      ) : null}
    </section>
  );
}

function OpsPanel({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: ReturnType<typeof useWorkspaceRole>;
}) {
  const status = useApi<{
    database: string;
    redis: string;
    pool: { total: number; idle: number; waiting: number } | null;
    controls: {
      research: boolean;
      discovery: boolean;
      enrich: boolean;
      ai: boolean;
      export: boolean;
    };
    limits: { concurrent_jobs: number };
    note: string;
  }>('/api/v1/ops/status', workspaceId);
  const retention = useApi<{
    expired_evidence_with_excerpt: number;
    suppression_hashes_retained: number;
    note: string;
  }>('/api/v1/ops/retention', workspaceId);
  const [error, setError] = useState<unknown>(null);

  async function toggle(key: string, enabled: boolean) {
    setError(null);
    try {
      await api('/api/v1/workspace-controls', {
        method: 'PATCH',
        workspaceId,
        body: { [`${key}_enabled`]: enabled },
      });
      status.reload();
    } catch (err) {
      setError(err);
    }
  }

  if (!allowed(role, 'readOps')) return null;

  return (
    <section aria-labelledby="ops" className="card">
      <h2 id="ops">Operations</h2>
      <p className="muted small">
        Process-local health and workspace kill switches. This is not a claim of production
        capacity.
      </p>
      <ErrorNotice error={status.error ?? retention.error ?? error} />
      {status.data ? (
        <dl className="facts">
          <dt>Database</dt>
          <dd>{status.data.database}</dd>
          <dt>Redis</dt>
          <dd>{status.data.redis}</dd>
          <dt>Pool</dt>
          <dd>
            {status.data.pool
              ? `${status.data.pool.idle} idle / ${status.data.pool.total} total`
              : 'n/a'}
          </dd>
          <dt>Concurrent job cap</dt>
          <dd>{status.data.limits.concurrent_jobs}</dd>
        </dl>
      ) : null}
      {allowed(role, 'manageOps') && status.data ? (
        <fieldset>
          <legend>Workspace kill switches</legend>
          {(
            [
              ['research', 'Research'],
              ['discovery', 'Discovery'],
              ['enrich', 'Enrichment'],
              ['ai', 'AI org-map'],
              ['export', 'Export'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={status.data!.controls[key]}
                onChange={(e) => toggle(key, e.target.checked)}
              />{' '}
              {label}
            </label>
          ))}
        </fieldset>
      ) : null}
      {retention.data ? (
        <p className="muted small">
          Expired evidence excerpts pending redact: {retention.data.expired_evidence_with_excerpt}.{' '}
          {retention.data.note}
        </p>
      ) : null}
      {allowed(role, 'manageOps') ? (
        <button
          type="button"
          className="button"
          onClick={async () => {
            setError(null);
            try {
              await api('/api/v1/ops/retention-sweep', { method: 'POST', workspaceId });
              retention.reload();
            } catch (err) {
              setError(err);
            }
          }}
        >
          Redact expired excerpts
        </button>
      ) : null}
    </section>
  );
}
