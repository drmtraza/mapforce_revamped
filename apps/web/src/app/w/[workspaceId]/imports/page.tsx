'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { StatusBadge } from '@/components/badges';
import { formatDate } from '@/components/evidence-list';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api, type ApiResponse } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type Batches = ApiResponse<'/api/v1/imports', 'get'>;
type ImportResult = ApiResponse<'/api/v1/imports/companies', 'post'>;
type BatchDetail = ApiResponse<'/api/v1/imports/{id}', 'get'>;

export default function ImportsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const role = useWorkspaceRole(workspaceId);
  const list = useApi<Batches>('/api/v1/imports?limit=25', workspaceId);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canWrite = allowed(role, 'writeImports');

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setPreview(null);
    setError(null);
  }

  async function upload(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const text = await file.text();
      const name = encodeURIComponent(file.name);
      const res = await api<ImportResult>(
        `/api/v1/imports/companies?dry_run=${dryRun ? 'true' : 'false'}&filename=${name}`,
        {
          method: 'POST',
          workspaceId,
          rawBody: { contentType: 'text/csv', text },
          headers: dryRun ? {} : { 'idempotency-key': crypto.randomUUID() },
        },
      );
      setPreview(res);
      if (!dryRun && res.import_id) {
        setSelectedId(res.import_id);
        list.reload();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function previewFile(e: FormEvent) {
    e.preventDefault();
    await upload(true);
  }

  return (
    <>
      <h1>Company import</h1>
      <p className="muted">
        CSV with a <code>domain</code> column. Optional <code>name</code>, <code>country</code>{' '}
        (ISO-2) and <code>industry</code>. Preview first; committing never overwrites an existing
        workspace company.
      </p>

      {canWrite ? (
        <section aria-labelledby="upload" className="card">
          <h2 id="upload">Upload</h2>
          <form onSubmit={previewFile} className="form-stack">
            <label htmlFor="csv">CSV file</label>
            <input id="csv" type="file" accept=".csv,text/csv" onChange={onFile} required />
            <div className="actions">
              <button type="submit" className="button" disabled={busy || !file}>
                {busy ? 'Working…' : 'Preview (dry run)'}
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={busy || !preview || preview.summary.created === 0}
                onClick={() => upload(false)}
              >
                Commit {preview ? `${preview.summary.created} new` : ''}
              </button>
            </div>
            <ErrorNotice error={error} />
          </form>
          {preview ? <Preview result={preview} workspaceId={workspaceId} /> : null}
        </section>
      ) : (
        <p className="muted">Your role can view past imports but cannot upload.</p>
      )}

      <section aria-labelledby="history" className="card">
        <h2 id="history">Past imports</h2>
        {list.loading ? <Loading /> : null}
        <ErrorNotice error={list.error} />
        {list.data && list.data.data.length === 0 ? <Empty>No imports yet.</Empty> : null}
        <ul className="list">
          {list.data?.data.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setSelectedId(b.id)}
              >
                {b.filename ?? 'Untitled CSV'}
              </button>
              <span className="muted small">
                {' '}
                · {b.summary.created} created, {b.summary.existing} existing, {b.summary.invalid}{' '}
                invalid · {formatDate(b.created_at)}
              </span>
            </li>
          ))}
        </ul>
        {selectedId ? <BatchRows workspaceId={workspaceId} importId={selectedId} /> : null}
      </section>
    </>
  );
}

function Preview({ result, workspaceId }: { result: ImportResult; workspaceId: string }) {
  return (
    <div>
      <p>
        {result.dry_run ? 'Dry run' : result.replayed ? 'Already committed' : 'Committed'}:{' '}
        {result.summary.rows} rows · {result.summary.created} new · {result.summary.existing}{' '}
        existing · {result.summary.duplicate_in_file} duplicates in file · {result.summary.invalid}{' '}
        invalid
      </p>
      {result.ignored_columns.length ? (
        <p className="muted small">Ignored columns: {result.ignored_columns.join(', ')}</p>
      ) : null}
      <RowTable rows={result.rows} workspaceId={workspaceId} />
      {result.rows_truncated ? (
        <p className="muted small">Preview limited to the first 1,000 rows.</p>
      ) : null}
    </div>
  );
}

function BatchRows({ workspaceId, importId }: { workspaceId: string; importId: string }) {
  const detail = useApi<BatchDetail>(`/api/v1/imports/${importId}?limit=100`, workspaceId);
  if (detail.loading) return <Loading />;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (!detail.data) return null;
  return (
    <>
      <h3>{detail.data.filename ?? 'Import'} rows</h3>
      <RowTable rows={detail.data.rows} workspaceId={workspaceId} />
    </>
  );
}

function RowTable({ rows, workspaceId }: { rows: ImportResult['rows']; workspaceId: string }) {
  if (rows.length === 0) return <Empty>No rows in this view.</Empty>;
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Row</th>
          <th scope="col">Domain</th>
          <th scope="col">Name</th>
          <th scope="col">Outcome</th>
          <th scope="col">Detail</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.row_number}>
            <td>{r.row_number}</td>
            <td>{r.normalized_domain ?? r.domain ?? '—'}</td>
            <td>{r.name ?? '—'}</td>
            <td>
              <StatusBadge status={r.outcome} />
            </td>
            <td>
              {r.company_id ? (
                <Link href={`/w/${workspaceId}/companies/${r.company_id}`}>Open company</Link>
              ) : (
                <span className="muted small">{r.error_message ?? ''}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
