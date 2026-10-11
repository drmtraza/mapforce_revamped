'use client';

import { useEffect, useState } from 'react';
import { api, type ApiResponse } from '@/lib/api';
import { StatusBadge } from './badges';
import { ErrorNotice } from './feedback';

type Job = ApiResponse<'/api/v1/research-jobs/{id}', 'get'>;
type Accepted = ApiResponse<'/api/v1/companies/{id}/research-jobs', 'post'>;

const TERMINAL = new Set(['succeeded', 'partial_success', 'failed', 'cancelled']);
const POLL_MS = 2000;
const MAX_POLLS = 450;

export function ResearchPanel({
  workspaceId,
  companyId,
  initialJobId,
  onFinished,
}: {
  workspaceId: string;
  companyId: string;
  initialJobId: string | null;
  onFinished: () => void;
}) {
  const [launchedJobId, setLaunchedJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const jobId = launchedJobId ?? initialJobId;

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await api<Job>(`/api/v1/research-jobs/${jobId}`, { workspaceId });
        if (!active) return;
        setJob(next);
        if (TERMINAL.has(next.status)) {
          onFinished();
          return;
        }
      } catch (err) {
        if (active) setError(err);
        return;
      }
      polls += 1;
      if (polls < MAX_POLLS) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, workspaceId, onFinished]);

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<Accepted>(`/api/v1/companies/${companyId}/research-jobs`, {
        method: 'POST',
        workspaceId,
        headers: { 'idempotency-key': crypto.randomUUID() },
      });
      setJob(null);
      setLaunchedJobId(res.job_id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!jobId) return;
    setBusy(true);
    try {
      await api(`/api/v1/research-jobs/${jobId}/cancel`, { method: 'POST', workspaceId });
      setJob((j) => (j ? { ...j, status: 'cancel_requested' } : j));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const active = job ? !TERMINAL.has(job.status) : Boolean(jobId);

  return (
    <section aria-labelledby="research" className="card">
      <div className="section-head">
        <h2 id="research">Research</h2>
        <div className="actions">
          {active && job?.status !== 'cancel_requested' ? (
            <button type="button" className="button" onClick={cancel} disabled={busy}>
              Cancel research
            </button>
          ) : null}
          <button
            type="button"
            className="button button-primary"
            onClick={launch}
            disabled={busy || active}
          >
            {job ? 'Run research again' : 'Run research'}
          </button>
        </div>
      </div>
      <ErrorNotice error={error} />
      {!jobId ? (
        <p className="muted">
          No research has run yet. Research collects public evidence and candidate people from the
          configured sources; nothing is sent to anyone.
        </p>
      ) : null}
      {job ? (
        <div aria-live="polite">
          <p>
            Status: <StatusBadge status={job.status} />
            {job.error_summary ? <span className="muted"> · {job.error_summary}</span> : null}
          </p>
          <table>
            <caption className="visually-hidden">Per-source status</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Status</th>
                <th scope="col">Attempts</th>
                <th scope="col">Evidence</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {job.sources.map((s) => (
                <tr key={s.source_key}>
                  <td>{s.source_key}</td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td>{s.attempts}</td>
                  <td>{s.evidence_count}</td>
                  <td className="muted small">
                    {s.error_code ? `${s.error_code}: ${s.error_summary ?? ''}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
