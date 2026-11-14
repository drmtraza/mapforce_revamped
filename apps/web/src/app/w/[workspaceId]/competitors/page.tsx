'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { StatusBadge } from '@/components/badges';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type Competitor = {
  id: string;
  name: string;
  domain: string | null;
  notes: string | null;
  status: string;
};

type Battlecard = {
  id: string;
  version: number;
  strengths: string;
  weaknesses: string;
  our_differentiators: string;
  certifications_note: string;
};

export default function CompetitorsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const role = useWorkspaceRole(workspaceId);
  const competitors = useApi<{ data: Competitor[]; note: string }>(
    '/api/v1/competitors',
    workspaceId,
  );
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [strengths, setStrengths] = useState('');
  const [weaknesses, setWeaknesses] = useState('');
  const [diffs, setDiffs] = useState('');
  const [card, setCard] = useState<Battlecard | null>(null);
  const canWrite = allowed(role, 'writeCompetitor');

  async function createCompetitor(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/v1/competitors', {
        method: 'POST',
        workspaceId,
        body: { name, domain: domain || null },
      });
      setName('');
      setDomain('');
      competitors.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function createBattlecard(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setError(null);
    try {
      const res = await api<Battlecard>(`/api/v1/competitors/${selectedId}/battlecards`, {
        method: 'POST',
        workspaceId,
        body: {
          strengths,
          weaknesses,
          our_differentiators: diffs,
          claim_type: 'user_assertion',
          evidence_ids: [],
        },
      });
      setCard(res);
      setStrengths('');
      setWeaknesses('');
      setDiffs('');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1>Competitors</h1>
        <p className="muted">
          {competitors.data?.note ??
            'Watchlist and battlecards. Do not assert certifications without evidence.'}
        </p>
      </header>
      <ErrorNotice error={competitors.error ?? error} />

      {canWrite ? (
        <form onSubmit={createCompetitor} className="stack">
          <label>
            Competitor name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
            />
          </label>
          <label>
            Domain (optional)
            <input value={domain} onChange={(e) => setDomain(e.target.value)} maxLength={253} />
          </label>
          <button type="submit">Add to watchlist</button>
        </form>
      ) : null}

      {competitors.loading ? <Loading /> : null}
      {!competitors.loading && !competitors.data?.data.length ? (
        <Empty>No competitors on the watchlist yet.</Empty>
      ) : null}
      <ul className="stack">
        {competitors.data?.data.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => setSelectedId(c.id)}>
              <strong>{c.name}</strong>
            </button>{' '}
            <StatusBadge status={c.status} />
            <p className="muted small">
              {c.domain ?? 'No domain'} · {c.notes ?? ''}
            </p>
          </li>
        ))}
      </ul>

      {selectedId && canWrite ? (
        <section aria-labelledby="battlecard">
          <h2 id="battlecard">New battlecard</h2>
          <form onSubmit={createBattlecard} className="stack">
            <label>
              Strengths
              <textarea value={strengths} onChange={(e) => setStrengths(e.target.value)} required />
            </label>
            <label>
              Weaknesses
              <textarea
                value={weaknesses}
                onChange={(e) => setWeaknesses(e.target.value)}
                required
              />
            </label>
            <label>
              Our differentiators
              <textarea value={diffs} onChange={(e) => setDiffs(e.target.value)} required />
            </label>
            <button type="submit">Save battlecard version</button>
          </form>
        </section>
      ) : null}

      {card ? (
        <article>
          <h3>
            Battlecard v{card.version} <StatusBadge status="saved" />
          </h3>
          <p>{card.strengths}</p>
          <p>{card.weaknesses}</p>
          <p>{card.our_differentiators}</p>
          <p className="muted small">{card.certifications_note}</p>
        </article>
      ) : null}
    </main>
  );
}
