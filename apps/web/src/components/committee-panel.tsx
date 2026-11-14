'use client';

import { useState, type FormEvent } from 'react';
import { ClaimTypeBadge, StatusBadge } from './badges';
import { Empty, ErrorNotice } from './feedback';
import { api } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type Member = {
  id: string;
  person_id: string;
  person_name: string | null;
  person_title: string | null;
  committee_role: string;
  claim_type: string;
  rationale: string;
  evidence_ids: string[];
  status: string;
};

type Coverage = {
  coverage_score: number;
  missing_required: string[];
  note: string;
};

type Plan = {
  id: string;
  version: number;
  status: string;
  title: string;
  coverage_score: number;
  coverage_note: string;
  reporting_note: string;
  next_steps: string;
  assigned_manager_user_id: string | null;
};

type PersonRow = { id: string; canonical_name: string };

export function CommitteePanel({
  workspaceId,
  companyId,
}: {
  workspaceId: string;
  companyId: string;
}) {
  const role = useWorkspaceRole(workspaceId);
  const committee = useApi<{ data: Member[]; coverage: Coverage; note: string }>(
    `/api/v1/companies/${companyId}/buying-committee`,
    workspaceId,
  );
  const plans = useApi<{ data: Plan[]; note: string }>(
    `/api/v1/companies/${companyId}/account-plans`,
    workspaceId,
  );
  const people = useApi<{ data: PersonRow[] }>(
    `/api/v1/companies/${companyId}/people`,
    workspaceId,
  );
  const [error, setError] = useState<unknown>(null);
  const [personId, setPersonId] = useState('');
  const [committeeRole, setCommitteeRole] = useState('champion');
  const [rationale, setRationale] = useState('');
  const [title, setTitle] = useState('Account plan');
  const [situation, setSituation] = useState('');
  const [objective, setObjective] = useState('');
  const [strategy, setStrategy] = useState('');
  const [nextSteps, setNextSteps] = useState('');
  const canWrite = allowed(role, 'writeCommittee');
  const canPlan = allowed(role, 'writePlan');

  async function addMember(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/v1/companies/${companyId}/buying-committee`, {
        method: 'POST',
        workspaceId,
        body: {
          person_id: personId,
          committee_role: committeeRole,
          claim_type: 'user_assertion',
          rationale,
          evidence_ids: [],
        },
      });
      setRationale('');
      committee.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function createPlan(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/v1/companies/${companyId}/account-plans`, {
        method: 'POST',
        workspaceId,
        body: {
          title,
          situation,
          objective,
          strategy,
          next_steps: nextSteps,
          activate: true,
        },
      });
      plans.reload();
    } catch (err) {
      setError(err);
    }
  }

  const latest = plans.data?.data[0];

  return (
    <section className="card" aria-labelledby="buying-committee">
      <h2 id="buying-committee">Buying committee & account plan</h2>
      <p className="muted small">
        {committee.data?.note ??
          'Classifications only — reporting lines are never invented. Budget owner needs evidence.'}
      </p>
      <ErrorNotice error={committee.error ?? plans.error ?? error} />

      {committee.data?.coverage ? (
        <p>
          Coverage <StatusBadge status={`${committee.data.coverage.coverage_score}_pct`} />{' '}
          <span className="muted small">{committee.data.coverage.note}</span>
        </p>
      ) : null}

      {!committee.data?.data.length ? <Empty>No committee members yet.</Empty> : null}
      <ul className="stack">
        {committee.data?.data.map((m) => (
          <li key={m.id}>
            <strong>{m.person_name ?? m.person_id}</strong> — {m.committee_role}{' '}
            <ClaimTypeBadge type={m.claim_type} />
            <p className="muted small">
              {m.person_title ?? 'No title'} · {m.rationale}
              {m.evidence_ids.length ? ` · evidence ${m.evidence_ids.length}` : ''}
            </p>
          </li>
        ))}
      </ul>

      {canWrite ? (
        <form onSubmit={addMember} className="stack">
          <label>
            Person
            <select value={personId} onChange={(e) => setPersonId(e.target.value)} required>
              <option value="">Select…</option>
              {(people.data?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.canonical_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Role
            <select value={committeeRole} onChange={(e) => setCommitteeRole(e.target.value)}>
              {[
                'economic_buyer',
                'champion',
                'technical_evaluator',
                'procurement',
                'legal',
                'end_user',
                'influencer',
                'coach',
                'blocker',
              ].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label>
            Rationale
            <input value={rationale} onChange={(e) => setRationale(e.target.value)} required />
          </label>
          <button type="submit">Add classification</button>
        </form>
      ) : null}

      <h3>Account plans</h3>
      <p className="muted small">{plans.data?.note}</p>
      {latest ? (
        <article>
          <p>
            v{latest.version} <StatusBadge status={latest.status} /> — {latest.title} (coverage{' '}
            {latest.coverage_score}%)
          </p>
          <p className="muted small">{latest.reporting_note}</p>
          <p>{latest.next_steps}</p>
        </article>
      ) : (
        <Empty>No account plans yet.</Empty>
      )}

      {canPlan ? (
        <form onSubmit={createPlan} className="stack">
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label>
            Situation
            <textarea value={situation} onChange={(e) => setSituation(e.target.value)} required />
          </label>
          <label>
            Objective
            <textarea value={objective} onChange={(e) => setObjective(e.target.value)} required />
          </label>
          <label>
            Strategy
            <textarea value={strategy} onChange={(e) => setStrategy(e.target.value)} required />
          </label>
          <label>
            Next steps
            <textarea value={nextSteps} onChange={(e) => setNextSteps(e.target.value)} required />
          </label>
          <button type="submit">Create active plan version</button>
        </form>
      ) : null}
    </section>
  );
}
