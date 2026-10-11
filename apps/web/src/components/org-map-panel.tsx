'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { ClaimTypeBadge, StatusBadge } from './badges';
import { Empty, ErrorNotice } from './feedback';

interface Draft {
  id: string;
  person_id: string;
  display_name: string;
  body: string;
  claim_type: 'model_inference';
  confidence: number;
  evidence_ids: string[];
  rationale: string;
  status: string;
  created_at: string;
}

export function OrgMapPanel({
  workspaceId,
  companyId,
  canRun,
  onFinished,
}: {
  workspaceId: string;
  companyId: string;
  canRun: boolean;
  onFinished: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ job_id: string; status: string }>(
        `/api/v1/companies/${companyId}/org-map-jobs`,
        {
          method: 'POST',
          workspaceId,
          headers: { 'idempotency-key': crypto.randomUUID() },
        },
      );
      setStatus(res.status);
      onFinished();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section-head">
      <p className="muted small">
        Personas and outreach angles are model inference. They are not source facts. Confidence is a
        heuristic, not a calibrated probability.
      </p>
      {canRun ? (
        <div className="actions">
          <button type="button" className="button button-primary" onClick={run} disabled={busy}>
            {busy ? 'Running mapping…' : 'Run AI mapping'}
          </button>
        </div>
      ) : null}
      <ErrorNotice error={error} />
      {status ? (
        <p aria-live="polite">
          Last mapping: <StatusBadge status={status} />
        </p>
      ) : null}
    </div>
  );
}

export function OutreachDrafts({ drafts }: { drafts: { data: Draft[]; note: string } | null }) {
  if (!drafts) return null;
  return (
    <>
      <h3>Outreach drafts</h3>
      <p className="muted small">{drafts.note}</p>
      {drafts.data.length === 0 ? <Empty>No drafts yet. Run AI mapping first.</Empty> : null}
      {drafts.data.length > 0 ? (
        <ul className="list">
          {drafts.data.map((d) => (
            <li key={d.id} className="claim">
              <p>
                <strong>{d.display_name}</strong> <ClaimTypeBadge type={d.claim_type} />{' '}
                <StatusBadge status={d.status} />{' '}
                <span className="muted small">{Math.round(d.confidence * 100)}% heuristic</span>
              </p>
              <p>{d.body}</p>
              <p className="muted small">
                {d.rationale} · {d.evidence_ids.length} evidence
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
