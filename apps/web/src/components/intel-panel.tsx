'use client';

import { useState } from 'react';
import { ClaimTypeBadge, StatusBadge } from './badges';
import { Empty, ErrorNotice } from './feedback';
import { api } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type Claim = {
  key: string;
  text: string;
  claim_type: string;
  evidence_ids: string[];
  agent: string;
};

type Report = {
  id: string;
  status: string;
  summary: string;
  sections: { id: string; title: string; claims: Claim[] }[];
  quarantined_claims: Claim[];
  agent_trace: { agent: string; ok: boolean; detail: string; duration_ms: number }[];
  note: string;
  created_at: string;
};

export function IntelPanel({ workspaceId, companyId }: { workspaceId: string; companyId: string }) {
  const role = useWorkspaceRole(workspaceId);
  const reports = useApi<{ data: Report[]; note: string }>(
    `/api/v1/companies/${companyId}/account-intelligence`,
    workspaceId,
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const latest = reports.data?.data[0];

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/companies/${companyId}/account-intelligence`, {
        method: 'POST',
        workspaceId,
      });
      reports.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function review(id: string, status: 'accepted' | 'dismissed') {
    setError(null);
    try {
      await api(`/api/v1/account-intelligence/${id}`, {
        method: 'PATCH',
        workspaceId,
        body: { status },
      });
      reports.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <section className="card" aria-labelledby="account-intel">
      <h2 id="account-intel">Account intelligence</h2>
      <p className="muted small">
        {reports.data?.note ??
          'One-click draft report. Review before any CRM write. Not buying intent.'}
      </p>
      <ErrorNotice error={reports.error ?? error} />
      {allowed(role, 'generateIntel') ? (
        <p>
          <button type="button" onClick={generate} disabled={busy}>
            {busy ? 'Generating…' : 'Generate complete account intelligence'}
          </button>
        </p>
      ) : null}
      {!latest ? <Empty>No reports yet.</Empty> : null}
      {latest ? (
        <article>
          <p>
            <StatusBadge status={latest.status} />{' '}
            <span className="muted small">{new Date(latest.created_at).toLocaleString()}</span>
          </p>
          <p>{latest.summary}</p>
          {latest.sections.map((s) => (
            <div key={s.id}>
              <h3>{s.title}</h3>
              <ul>
                {s.claims.map((c) => (
                  <li key={c.key}>
                    <ClaimTypeBadge type={c.claim_type} /> {c.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {latest.quarantined_claims.length ? (
            <div>
              <h3>Quarantined</h3>
              <ul>
                {latest.quarantined_claims.map((c) => (
                  <li key={c.key}>{c.text}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <details>
            <summary>Agent trace</summary>
            <ul>
              {latest.agent_trace.map((t, i) => (
                <li key={`${t.agent}-${i}`}>
                  {t.agent}: {t.ok ? 'ok' : 'fail'} — {t.detail} ({t.duration_ms}ms)
                </li>
              ))}
            </ul>
          </details>
          {allowed(role, 'reviewIntel') && latest.status === 'draft_for_review' ? (
            <p>
              <button type="button" onClick={() => review(latest.id, 'accepted')}>
                Accept (CRM unchanged)
              </button>{' '}
              <button type="button" onClick={() => review(latest.id, 'dismissed')}>
                Dismiss
              </button>
            </p>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
