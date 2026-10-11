'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ClaimTypeBadge, MockBadge, StatusBadge } from '@/components/badges';
import { formatDate } from '@/components/evidence-list';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api, type ApiResponse } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type Searches = ApiResponse<'/api/v1/discovery-searches', 'get'>;
type Search = ApiResponse<'/api/v1/discovery-searches/{id}', 'get'>;
type Accepted = ApiResponse<'/api/v1/discovery-searches', 'post'>;
type Candidate = Search['candidates'][number];

const TERMINAL = new Set(['succeeded', 'partial_success', 'failed', 'cancelled']);
const EUROPE = [
  'AT',
  'BE',
  'BG',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IS',
  'IT',
  'LI',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
];
const PRESETS: { label: string; codes: string[] }[] = [
  { label: 'United States', codes: ['US'] },
  { label: 'United Kingdom', codes: ['GB'] },
  { label: 'EU / EEA + Switzerland', codes: EUROPE },
];

export default function DiscoveryPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const role = useWorkspaceRole(workspaceId);
  const list = useApi<Searches>('/api/v1/discovery-searches?limit=25', workspaceId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [countries, setCountries] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<Accepted>('/api/v1/discovery-searches', {
        method: 'POST',
        workspaceId,
        body: { text: text.trim(), country_codes: countries },
        headers: { 'idempotency-key': crypto.randomUUID() },
      });
      setSelectedId(res.job_id);
      list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function addCountries(codes: string[]) {
    setCountries([...new Set([...countries, ...codes])]);
  }

  return (
    <>
      <h1>Discovery</h1>
      <p className="muted">
        Search permitted sources for candidate companies. Results stay as reviewable candidates
        until someone accepts them; they are never created automatically.
      </p>

      {allowed(role, 'startDiscovery') ? (
        <section aria-labelledby="new-search" className="card">
          <h2 id="new-search">New search</h2>
          <form onSubmit={start} className="form-stack">
            <label htmlFor="q">What to look for</label>
            <input
              id="q"
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
              minLength={3}
              maxLength={200}
              placeholder="freight software"
            />
            <label htmlFor="countries">Countries (ISO codes)</label>
            <input
              id="countries"
              value={countries.join(', ')}
              onChange={(e) =>
                setCountries(
                  e.target.value
                    .split(',')
                    .map((c) => c.trim().toUpperCase())
                    .filter(Boolean),
                )
              }
              placeholder="US, GB, DE"
            />
            <div className="actions">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="button button-quiet"
                  onClick={() => addCountries(p.codes)}
                >
                  Add {p.label}
                </button>
              ))}
            </div>
            <div>
              <button
                type="submit"
                className="button button-primary"
                disabled={busy || text.trim().length < 3}
              >
                {busy ? 'Starting…' : 'Search'}
              </button>
            </div>
            <ErrorNotice error={error} />
          </form>
        </section>
      ) : (
        <p className="muted">Your role can view results but cannot start a search.</p>
      )}

      <section aria-labelledby="past-searches" className="card">
        <h2 id="past-searches">Recent searches</h2>
        {list.loading ? <Loading /> : null}
        <ErrorNotice error={list.error} />
        {list.data && list.data.data.length === 0 ? <Empty>No searches yet.</Empty> : null}
        <ul className="list">
          {list.data?.data.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setSelectedId(s.id)}
                aria-current={selectedId === s.id ? 'true' : undefined}
              >
                {s.query.text}
              </button>{' '}
              <StatusBadge status={s.status} />{' '}
              <span className="muted small">
                {s.candidate_count} candidates · {formatDate(s.created_at)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {selectedId ? (
        <SearchDetail
          workspaceId={workspaceId}
          searchId={selectedId}
          canWrite={allowed(role, 'writeCompanies')}
          canCancel={allowed(role, 'cancelJobs')}
          onChanged={list.reload}
        />
      ) : null}
    </>
  );
}

function SearchDetail({
  workspaceId,
  searchId,
  canWrite,
  canCancel,
  onChanged,
}: {
  workspaceId: string;
  searchId: string;
  canWrite: boolean;
  canCancel: boolean;
  onChanged: () => void;
}) {
  const [search, setSearch] = useState<Search | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await api<Search>(`/api/v1/discovery-searches/${searchId}`, { workspaceId });
    setSearch(next);
    return next;
  }, [searchId, workspaceId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const tick = async () => {
      try {
        const next = await load();
        if (!active) return;
        if (TERMINAL.has(next.status) || polls >= 450) {
          onChanged();
          return;
        }
      } catch (err) {
        if (active) setError(err);
        return;
      }
      polls += 1;
      timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [load, onChanged]);

  async function decide(id: string, action: 'accept' | 'dismiss') {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/v1/discovery-candidates/${id}/${action}`, { method: 'POST', workspaceId });
      await load();
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  }

  async function cancel() {
    setError(null);
    try {
      await api(`/api/v1/discovery-searches/${searchId}/cancel`, { method: 'POST', workspaceId });
      await load();
    } catch (err) {
      setError(err);
    }
  }

  if (!search && !error) return <Loading label="Loading search" />;
  if (!search) return <ErrorNotice error={error} />;

  return (
    <section aria-labelledby="search-detail" className="card">
      <div className="section-head">
        <h2 id="search-detail">Results for “{search.query.text}”</h2>
        {canCancel && !TERMINAL.has(search.status) && search.status !== 'cancel_requested' ? (
          <button type="button" className="button" onClick={cancel}>
            Cancel search
          </button>
        ) : null}
      </div>
      <p>
        Status: <StatusBadge status={search.status} />
        {search.query.country_codes.length ? (
          <span className="muted"> · {search.query.country_codes.join(', ')}</span>
        ) : null}
      </p>
      <ErrorNotice error={error} />
      <table>
        <caption className="visually-hidden">Per-source status</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Status</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {search.sources.map((s) => (
            <tr key={s.source_key}>
              <td>{s.source_key}</td>
              <td>
                <StatusBadge status={s.status} />
              </td>
              <td className="muted small">
                {s.error_code ? `${s.error_code}: ${s.error_summary ?? ''}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Candidates</h3>
      {search.candidates.length === 0 ? (
        <Empty>
          {TERMINAL.has(search.status) ? 'No candidates from this search.' : 'Waiting for sources…'}
        </Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Domain</th>
              <th scope="col">Country</th>
              <th scope="col">Provenance</th>
              <th scope="col">Status</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {search.candidates.map((c) => (
              <CandidateRow
                key={c.id}
                candidate={c}
                workspaceId={workspaceId}
                busy={busyId === c.id}
                canWrite={canWrite}
                onAccept={() => decide(c.id, 'accept')}
                onDismiss={() => decide(c.id, 'dismiss')}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CandidateRow({
  candidate: c,
  workspaceId,
  busy,
  canWrite,
  onAccept,
  onDismiss,
}: {
  candidate: Candidate;
  workspaceId: string;
  busy: boolean;
  canWrite: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const companyId = c.company_id ?? c.existing_company_id;
  return (
    <tr>
      <td>{c.name}</td>
      <td>{c.domain}</td>
      <td>{c.country_code ?? <span className="muted">Unknown</span>}</td>
      <td>
        <ClaimTypeBadge type={c.claim_type} />{' '}
        <a href={c.evidence_url} target="_blank" rel="noopener noreferrer nofollow">
          Evidence
        </a>
        {c.source_key.startsWith('mock_') ? (
          <>
            {' '}
            <MockBadge />
          </>
        ) : null}
      </td>
      <td>
        <StatusBadge status={c.status} />
      </td>
      <td>
        {c.status === 'accepted' && companyId ? (
          <Link href={`/w/${workspaceId}/companies/${companyId}`}>Open company</Link>
        ) : null}
        {c.status === 'new' && canWrite ? (
          <div className="actions">
            <button
              type="button"
              className="button button-primary"
              onClick={onAccept}
              disabled={busy}
            >
              Accept
            </button>
            <button type="button" className="button" onClick={onDismiss} disabled={busy}>
              Dismiss
            </button>
          </div>
        ) : null}
      </td>
    </tr>
  );
}
