'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { StatusBadge } from '@/components/badges';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type Tender = {
  id: string;
  title: string;
  buyer_name: string;
  category: string;
  country_code: string | null;
  status: string;
  closes_at: string | null;
  source_key: string;
};

type Assessment = {
  id: string;
  recommendation: string;
  fit_score: number;
  note: string;
  human_decision: string | null;
  missing_information: string[];
};

export default function TendersPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const role = useWorkspaceRole(workspaceId);
  const tenders = useApi<{ data: Tender[]; note: string }>('/api/v1/tenders', workspaceId);
  const [error, setError] = useState<unknown>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const canWrite = allowed(role, 'writeTender');
  const canAssess = allowed(role, 'assessTender');
  const canDecide = allowed(role, 'decideTender');

  async function syncMock() {
    setError(null);
    try {
      await api('/api/v1/tenders/sync-mock', { method: 'POST', workspaceId });
      tenders.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function assess(id: string) {
    setError(null);
    try {
      const res = await api<Assessment>(`/api/v1/tenders/${id}/bid-assessments`, {
        method: 'POST',
        workspaceId,
      });
      setAssessment(res);
    } catch (err) {
      setError(err);
    }
  }

  async function decide(decision: 'bid' | 'no_bid' | 'defer') {
    if (!assessment) return;
    setError(null);
    try {
      const res = await api<Assessment>(`/api/v1/tender-bid-assessments/${assessment.id}`, {
        method: 'PATCH',
        workspaceId,
        body: { human_decision: decision },
      });
      setAssessment(res);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1>Tenders</h1>
        <p className="muted">
          {tenders.data?.note ?? 'Bid assist only — Mapforce never auto-submits bids.'}
        </p>
      </header>
      <ErrorNotice error={tenders.error ?? error} />
      {canWrite ? (
        <p>
          <button type="button" onClick={syncMock}>
            Sync mock tenders
          </button>
        </p>
      ) : null}
      {tenders.loading ? <Loading /> : null}
      {!tenders.loading && !tenders.data?.data.length ? (
        <Empty>No tenders yet. Sync the mock source to load fixtures.</Empty>
      ) : null}
      <ul className="stack">
        {tenders.data?.data.map((t) => (
          <li key={t.id}>
            <article>
              <h2>
                {t.title} <StatusBadge status={t.status} />
              </h2>
              <p className="muted small">
                {t.buyer_name} · {t.category} · {t.country_code ?? '—'} · closes{' '}
                {t.closes_at ? new Date(t.closes_at).toLocaleDateString() : 'unknown'} ·{' '}
                {t.source_key}
              </p>
              {canAssess ? (
                <button type="button" onClick={() => assess(t.id)}>
                  Run bid/no-bid assist
                </button>
              ) : null}
            </article>
          </li>
        ))}
      </ul>
      {assessment ? (
        <section aria-labelledby="bid-assist">
          <h2 id="bid-assist">Latest assessment</h2>
          <p>
            Recommend <StatusBadge status={assessment.recommendation} /> · fit{' '}
            {assessment.fit_score}
            {assessment.human_decision
              ? ` · human: ${assessment.human_decision}`
              : ' · awaiting human decision'}
          </p>
          <p className="muted small">{assessment.note}</p>
          {assessment.missing_information.length ? (
            <ul>
              {assessment.missing_information.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
          {canDecide && !assessment.human_decision ? (
            <p>
              <button type="button" onClick={() => decide('bid')}>
                Decide: bid
              </button>{' '}
              <button type="button" onClick={() => decide('no_bid')}>
                Decide: no-bid
              </button>{' '}
              <button type="button" onClick={() => decide('defer')}>
                Defer
              </button>
            </p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
