'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { StatusBadge } from '@/components/badges';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

const STAGES = [
  'identified',
  'researching',
  'qualified',
  'outreach',
  'meeting',
  'closed_won',
  'closed_lost',
  'on_hold',
] as const;

type Account = {
  company_id: string;
  canonical_name: string;
  primary_domain: string;
  owner_user_id: string | null;
  stage: (typeof STAGES)[number];
  priority: string;
  total_score: number | null;
  eligible: boolean | null;
};

export default function PipelinePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const role = useWorkspaceRole(workspaceId);
  const accounts = useApi<{ data: Account[] }>('/api/v1/accounts', workspaceId);
  const [error, setError] = useState<unknown>(null);
  const canAssign = allowed(role, 'assignAccounts');

  async function move(companyId: string, stage: Account['stage']) {
    setError(null);
    try {
      await api(`/api/v1/accounts/${companyId}`, {
        method: 'PATCH',
        workspaceId,
        body: { stage },
      });
      accounts.reload();
    } catch (err) {
      setError(err);
    }
  }

  if (accounts.loading && !accounts.data) return <Loading />;
  if (accounts.error) return <ErrorNotice error={accounts.error} />;

  return (
    <>
      <h1>Pipeline</h1>
      <p className="muted small">
        Stages are workspace workflow state. Score is a heuristic; suppression makes an account
        ineligible.
      </p>
      <ErrorNotice error={error} />
      <div className="pipeline">
        {STAGES.map((stage) => {
          const cards = (accounts.data?.data ?? []).filter((a) => a.stage === stage);
          return (
            <section key={stage} className="pipeline-col card" aria-labelledby={`stage-${stage}`}>
              <h2 id={`stage-${stage}`}>
                {stage.replace(/_/g, ' ')} <span className="muted">({cards.length})</span>
              </h2>
              {cards.length === 0 ? <Empty>None</Empty> : null}
              <ul className="list">
                {cards.map((a) => (
                  <li key={a.company_id}>
                    <p>
                      <Link href={`/w/${workspaceId}/companies/${a.company_id}`}>
                        {a.canonical_name}
                      </Link>{' '}
                      <StatusBadge status={a.priority} />
                    </p>
                    <p className="muted small">
                      {a.primary_domain}
                      {a.total_score !== null ? ` · score ${a.total_score}` : ''}
                      {a.eligible === false ? ' · ineligible' : ''}
                    </p>
                    {canAssign ? (
                      <label>
                        Stage for {a.canonical_name}
                        <select
                          aria-label={`Stage for ${a.canonical_name}`}
                          value={a.stage}
                          onChange={(e) => move(a.company_id, e.target.value as Account['stage'])}
                        >
                          {STAGES.map((s) => (
                            <option key={s} value={s}>
                              {s.replace(/_/g, ' ')}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
