'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ClaimTypeBadge, StatusBadge } from '@/components/badges';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type Opportunity = {
  id: string;
  company_domain: string | null;
  company_name: string | null;
  opportunity_kind: string;
  title: string;
  summary: string;
  claim_type: string;
  claim_label: string;
  freshness_score: number;
  observed_at: string;
  status: string;
  note: string;
};

type Mission = {
  id: string;
  name: string;
  status: string;
  interval_hours: number;
  daily_run_budget: number;
  runs_today: number;
  last_run_at: string | null;
  next_run_at: string | null;
};

export default function RadarPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const role = useWorkspaceRole(workspaceId);
  const feed = useApi<{ data: Opportunity[]; note: string }>(
    '/api/v1/opportunity-radar',
    workspaceId,
  );
  const missions = useApi<{ data: Mission[]; note: string }>('/api/v1/radar-missions', workspaceId);
  const [error, setError] = useState<unknown>(null);
  const [missionName, setMissionName] = useState('Daily market scan');
  const canWrite = allowed(role, 'writeRadar');
  const canMission = allowed(role, 'manageMissions');

  async function refresh() {
    setError(null);
    try {
      await api('/api/v1/opportunity-radar/refresh', { method: 'POST', workspaceId });
      feed.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function dismiss(id: string) {
    setError(null);
    try {
      await api(`/api/v1/opportunity-radar/${id}`, {
        method: 'PATCH',
        workspaceId,
        body: { status: 'dismissed' },
      });
      feed.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function createMission(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/v1/radar-missions', {
        method: 'POST',
        workspaceId,
        body: { name: missionName, interval_hours: 24, daily_run_budget: 4 },
      });
      setMissionName('Daily market scan');
      missions.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function runMission(id: string) {
    setError(null);
    try {
      await api(`/api/v1/radar-missions/${id}/run`, { method: 'POST', workspaceId });
      missions.reload();
      feed.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function toggleMission(m: Mission) {
    setError(null);
    try {
      await api(`/api/v1/radar-missions/${m.id}`, {
        method: 'PATCH',
        workspaceId,
        body: { status: m.status === 'active' ? 'paused' : 'active' },
      });
      missions.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1>Opportunity radar</h1>
        <p className="muted">
          {feed.data?.note ??
            'Freshness decays with age. Labels separate verified sources from model inference.'}
        </p>
      </header>
      <ErrorNotice error={feed.error ?? missions.error ?? error} />

      {canWrite ? (
        <p>
          <button type="button" onClick={refresh}>
            Refresh feed from signals
          </button>
        </p>
      ) : null}

      <section aria-labelledby="radar-feed">
        <h2 id="radar-feed">Open opportunities</h2>
        {feed.loading ? <Loading /> : null}
        {!feed.loading && !feed.data?.data.length ? (
          <Empty>No open opportunities. Refresh after research signals land.</Empty>
        ) : null}
        <ul className="stack">
          {feed.data?.data.map((o) => (
            <li key={o.id}>
              <article>
                <h3>
                  {o.title} <ClaimTypeBadge type={o.claim_type} />{' '}
                  <StatusBadge status={`freshness_${o.freshness_score}`} />
                </h3>
                <p className="muted small">
                  {o.company_name ?? o.company_domain ?? 'Unknown company'} · {o.opportunity_kind} ·{' '}
                  {o.claim_label} · {new Date(o.observed_at).toLocaleString()}
                </p>
                <p>{o.summary}</p>
                <p className="muted small">{o.note}</p>
                {canWrite ? (
                  <button type="button" onClick={() => dismiss(o.id)}>
                    Dismiss
                  </button>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="radar-missions">
        <h2 id="radar-missions">Missions</h2>
        <p className="muted small">
          {missions.data?.note ??
            'Pause, resume, and daily run budgets. Temporal Schedule wiring comes later.'}
        </p>
        {canMission ? (
          <form onSubmit={createMission} className="stack">
            <label>
              Mission name
              <input
                value={missionName}
                onChange={(e) => setMissionName(e.target.value)}
                required
                maxLength={120}
              />
            </label>
            <button type="submit">Create mission</button>
          </form>
        ) : null}
        <ul className="stack">
          {missions.data?.data.map((m) => (
            <li key={m.id}>
              <strong>{m.name}</strong> <StatusBadge status={m.status} />
              <p className="muted small">
                every {m.interval_hours}h · {m.runs_today}/{m.daily_run_budget} runs today
                {m.last_run_at ? ` · last ${new Date(m.last_run_at).toLocaleString()}` : ''}
              </p>
              {canMission ? (
                <p>
                  <button type="button" onClick={() => runMission(m.id)}>
                    Run now
                  </button>{' '}
                  <button type="button" onClick={() => toggleMission(m)}>
                    {m.status === 'active' ? 'Pause' : 'Resume'}
                  </button>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
