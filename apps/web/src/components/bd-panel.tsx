'use client';

import { useState, type FormEvent } from 'react';
import { StatusBadge } from './badges';
import { Empty, ErrorNotice } from './feedback';
import { api } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type Score = {
  total_score: number;
  eligible: boolean;
  suppression_override: boolean;
  explanation: string;
  factors: { key: string; value: number; max: number; rationale: string }[];
};

type ListRow = { id: string; name: string; kind: string };
type Task = { id: string; title: string; status: string };
type Note = { id: string; body: string; created_at: string };
type Icp = { id: string; name: string };

export function BdPanel({
  workspaceId,
  companyId,
  onChanged,
}: {
  workspaceId: string;
  companyId: string;
  onChanged?: () => void;
}) {
  const role = useWorkspaceRole(workspaceId);
  const score = useApi<{ score: Score | null }>(
    `/api/v1/companies/${companyId}/score`,
    workspaceId,
  );
  const icps = useApi<{ data: Icp[] }>('/api/v1/icp-profiles', workspaceId);
  const lists = useApi<{ data: ListRow[] }>('/api/v1/lists', workspaceId);
  const tasks = useApi<{ data: Task[] }>(`/api/v1/companies/${companyId}/tasks`, workspaceId);
  const notes = useApi<{ data: Note[] }>(`/api/v1/companies/${companyId}/notes`, workspaceId);
  const [error, setError] = useState<unknown>(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [listId, setListId] = useState('');

  async function runScore() {
    const icpId = icps.data?.data[0]?.id;
    if (!icpId) {
      setError(new Error('Create an ICP profile first.'));
      return;
    }
    setError(null);
    try {
      await api(`/api/v1/icp-profiles/${icpId}/score-runs`, {
        method: 'POST',
        workspaceId,
        body: { company_ids: [companyId] },
      });
      score.reload();
      onChanged?.();
    } catch (err) {
      setError(err);
    }
  }

  async function addToList(e: FormEvent) {
    e.preventDefault();
    if (!listId) return;
    setError(null);
    try {
      await api(`/api/v1/lists/${listId}/items`, {
        method: 'POST',
        workspaceId,
        body: { entity_type: 'company', entity_id: companyId },
      });
      lists.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function addTask(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/v1/tasks', {
        method: 'POST',
        workspaceId,
        body: { company_id: companyId, title: taskTitle },
      });
      setTaskTitle('');
      tasks.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function addNote(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/v1/notes', {
        method: 'POST',
        workspaceId,
        body: { company_id: companyId, body: noteBody },
      });
      setNoteBody('');
      notes.reload();
    } catch (err) {
      setError(err);
    }
  }

  const s = score.data?.score;

  return (
    <section aria-labelledby="bd" className="card">
      <h2 id="bd">Score and workspace</h2>
      <p className="muted small">
        Score is explainable and versioned. Suppression and ICP exclusions override it to ineligible
        / 0.
      </p>
      <ErrorNotice error={score.error ?? error} />
      {s ? (
        <>
          <p>
            Total {s.total_score}/100{' '}
            <StatusBadge status={s.eligible ? 'eligible' : 'ineligible'} />
          </p>
          <p className="muted small">{s.explanation}</p>
          <ul className="list">
            {s.factors.map((f) => (
              <li key={f.key}>
                <strong>
                  {f.key.replace('_', ' ')} {f.value}/{f.max}
                </strong>
                <p className="muted small">{f.rationale}</p>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Empty>No score yet.</Empty>
      )}
      {allowed(role, 'runScore') ? (
        <button type="button" className="button button-primary" onClick={runScore}>
          Score against active ICP
        </button>
      ) : null}

      {allowed(role, 'writeLists') && lists.data ? (
        <form onSubmit={addToList}>
          <label>
            Add to list
            <select value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">Select a company list</option>
              {lists.data.data
                .filter((l) => l.kind === 'companies')
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit" className="button" disabled={!listId}>
            Add to list
          </button>
        </form>
      ) : null}

      <h3>Tasks</h3>
      {tasks.data && tasks.data.data.length === 0 ? <Empty>No tasks.</Empty> : null}
      <ul className="list">
        {tasks.data?.data.map((t) => (
          <li key={t.id}>
            {t.title} <StatusBadge status={t.status} />
          </li>
        ))}
      </ul>
      {allowed(role, 'writeCrm') ? (
        <form onSubmit={addTask}>
          <label>
            New task
            <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} required />
          </label>
          <button type="submit" className="button">
            Add task
          </button>
        </form>
      ) : null}

      <h3>Notes</h3>
      {notes.data && notes.data.data.length === 0 ? <Empty>No notes.</Empty> : null}
      <ul className="list">
        {notes.data?.data.map((n) => (
          <li key={n.id}>{n.body}</li>
        ))}
      </ul>
      {allowed(role, 'writeCrm') ? (
        <form onSubmit={addNote}>
          <label>
            New note
            <textarea value={noteBody} onChange={(e) => setNoteBody(e.target.value)} required />
          </label>
          <button type="submit" className="button">
            Add note
          </button>
        </form>
      ) : null}
    </section>
  );
}
