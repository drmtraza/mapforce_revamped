'use client';

import { useState } from 'react';
import { StatusBadge } from './badges';
import { Empty, ErrorNotice } from './feedback';
import { api } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type MatchRow = {
  id: string;
  offering_name: string;
  offering_category: string;
  match_score: number;
  commercial_potential: number;
  confidence: string;
  eligible: boolean;
  suppression_override: boolean;
  factors: { key: string; value: number; max: number; rationale: string }[];
  missing_information: string[];
  recommended_approach: string;
  recommended_next_action: string;
  note: string;
};

export function MatchPanel({ workspaceId, companyId }: { workspaceId: string; companyId: string }) {
  const role = useWorkspaceRole(workspaceId);
  const matches = useApi<{
    run_id: string | null;
    account_score_note: string;
    data: MatchRow[];
  }>(`/api/v1/companies/${companyId}/opportunity-matches`, workspaceId);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function runMatch() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/companies/${companyId}/opportunity-matches`, {
        method: 'POST',
        workspaceId,
      });
      matches.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="product-match">
      <h2 id="product-match">Product opportunity match</h2>
      <p className="muted small">
        {matches.data?.account_score_note ??
          'Product-fit heuristics only — not ICP account score and not confirmed buying intent.'}
      </p>
      <ErrorNotice error={matches.error ?? error} />
      {allowed(role, 'runMatch') ? (
        <button type="button" className="button" disabled={busy} onClick={runMatch}>
          {busy ? 'Matching…' : 'Match catalogue offerings'}
        </button>
      ) : null}
      {!matches.data?.data.length ? <Empty>No match run yet.</Empty> : null}
      <ul className="list">
        {(matches.data?.data ?? []).map((m) => (
          <li key={m.id}>
            <p>
              <strong>{m.offering_name}</strong> <StatusBadge status={m.offering_category} />{' '}
              <StatusBadge status={m.confidence} />
            </p>
            <p>
              Match {m.match_score}/100 · Commercial potential {m.commercial_potential}/100
              {m.suppression_override ? ' · suppressed' : ''}
              {!m.eligible ? ' · ineligible' : ''}
            </p>
            <p className="muted small">{m.recommended_approach}</p>
            <p className="muted small">Next: {m.recommended_next_action}</p>
            {m.missing_information.length ? (
              <p className="muted small">Missing: {m.missing_information.join('; ')}</p>
            ) : null}
            <ul className="muted small">
              {m.factors
                .filter((f) => f.key !== 'commercial_potential')
                .map((f) => (
                  <li key={f.key}>
                    {f.key}: {f.value}/{f.max} — {f.rationale}
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
