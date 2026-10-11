'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ClaimTypeBadge, ConfidenceBadge, MockBadge, StatusBadge } from '@/components/badges';
import { formatDate } from '@/components/evidence-list';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api, ApiError, type ApiResponse } from '@/lib/api';
import { useApi } from '@/lib/use-api';

type Person = ApiResponse<'/api/v1/people/{id}', 'get'>;
type Decision = 'confirm' | 'reject' | 'dispute';

const PREDICATE_LABEL: Record<string, string> = {
  full_name: 'Name',
  title: 'Title',
  works_at: 'Works at',
  department: 'Department',
  seniority: 'Seniority',
};

function display(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

export default function PersonPage() {
  const { workspaceId, personId } = useParams<{ workspaceId: string; personId: string }>();
  const person = useApi<Person>(`/api/v1/people/${personId}`, workspaceId);
  const [decision, setDecision] = useState<Decision>('confirm');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function review(e: FormEvent) {
    e.preventDefault();
    if (!person.data) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await api(`/api/v1/people/${personId}/review`, {
        method: 'POST',
        workspaceId,
        body: {
          decision,
          expected_version: person.data.version,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      setReason('');
      setSaved('Review recorded.');
      person.reload();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? new ApiError(
              409,
              err.code,
              'Someone else updated this person. Reloaded the latest version; please review again.',
              err.correlationId,
            )
          : err,
      );
      person.reload();
    } finally {
      setBusy(false);
    }
  }

  if (person.loading && !person.data) return <Loading />;
  if (person.error) return <ErrorNotice error={person.error} />;
  if (!person.data) return null;
  const p = person.data;
  const companyId = p.roles[0]?.company_id;

  return (
    <>
      <p className="breadcrumb">
        <Link href={`/w/${workspaceId}/companies`}>Companies</Link>
        {companyId ? (
          <>
            {' '}
            / <Link href={`/w/${workspaceId}/companies/${companyId}`}>Company</Link>
          </>
        ) : null}{' '}
        / {p.canonical_name}
      </p>
      <h1>
        {p.canonical_name} <StatusBadge status={p.review_status} />
      </h1>

      <section aria-labelledby="roles" className="card">
        <h2 id="roles">Roles</h2>
        {p.roles.length === 0 ? <Empty>No roles recorded.</Empty> : null}
        <ul className="list">
          {p.roles.map((r) => (
            <li key={r.id}>
              {r.title ?? 'Title unknown'}
              {r.department ? <span className="muted"> · {r.department}</span> : null}{' '}
              <StatusBadge status={r.status} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="claims" className="card">
        <h2 id="claims">Claims and provenance</h2>
        <p className="muted small">
          Every claim lists the evidence it rests on. Model inferences are labelled and are never
          presented as sourced facts.
        </p>
        {p.claims.length === 0 ? <Empty>No claims recorded.</Empty> : null}
        <ul className="list">
          {p.claims.map((c) => (
            <li key={c.id} className="claim">
              <p>
                <strong>{PREDICATE_LABEL[c.predicate] ?? c.predicate}:</strong> {display(c.value)}{' '}
                <ClaimTypeBadge type={c.claim_type} /> <ConfidenceBadge confidence={c.confidence} />{' '}
                <StatusBadge status={c.status} />
              </p>
              {c.rationale ? <p className="muted small">{c.rationale}</p> : null}
              <p className="muted small">{c.confidence.explanation}</p>
              <ul className="evidence-refs">
                {c.evidence.map((e) => (
                  <li key={e.id}>
                    <a href={e.source_url} target="_blank" rel="noopener noreferrer nofollow">
                      {e.source_url}
                    </a>{' '}
                    {e.is_mock ? <MockBadge /> : null}
                    <span className="muted small">
                      {' '}
                      · {e.provider_name} · fetched {formatDate(e.fetched_at)}
                    </span>
                    {e.excerpt ? <blockquote>{e.excerpt}</blockquote> : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="contact" className="card">
        <h2 id="contact">Contact points</h2>
        <p className="muted">{p.contact_points_note}</p>
      </section>

      <section aria-labelledby="review" className="card">
        <h2 id="review">Review</h2>
        <form onSubmit={review} className="form-stack">
          <fieldset>
            <legend>Decision</legend>
            {(
              [
                ['confirm', 'Confirm: evidence supports this person and role'],
                ['dispute', 'Dispute: evidence is conflicting or unclear'],
                ['reject', 'Reject: wrong person or not at this company'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="radio">
                <input
                  type="radio"
                  name="decision"
                  value={value}
                  checked={decision === value}
                  onChange={() => setDecision(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <label htmlFor="reason">Reason (optional)</label>
          <textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            rows={3}
          />
          <div>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Record review'}
            </button>
          </div>
          {saved ? (
            <p role="status" className="notice notice-ok">
              {saved}
            </p>
          ) : null}
          <ErrorNotice error={error} />
        </form>
        <h3>History</h3>
        {p.reviews.length === 0 ? <Empty>No reviews yet.</Empty> : null}
        <ul className="list">
          {p.reviews.map((r, i) => (
            <li key={`${r.created_at}-${i}`}>
              <StatusBadge status={r.decision} /> {formatDate(r.created_at)}
              {r.reason ? <span className="muted"> · {r.reason}</span> : null}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
