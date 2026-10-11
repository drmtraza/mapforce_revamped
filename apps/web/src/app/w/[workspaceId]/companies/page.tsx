'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api, type ApiResponse } from '@/lib/api';
import { useApi } from '@/lib/use-api';

type Companies = ApiResponse<'/api/v1/companies', 'get'>;
type Created = ApiResponse<'/api/v1/companies', 'post'>;

export default function CompaniesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [extra, setExtra] = useState<Companies['data']>([]);
  // undefined until the user pages; then the cursor returned by the last page (null = end).
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const path = `/api/v1/companies?limit=25${search ? `&query=${encodeURIComponent(search)}` : ''}`;
  const list = useApi<Companies>(path, workspaceId);

  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<Created>('/api/v1/companies', {
        method: 'POST',
        body: { domain: domain.trim() },
        workspaceId,
      });
      router.push(`/w/${workspaceId}/companies/${res.company.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function loadMore() {
    const next = cursor === undefined ? list.data?.next_cursor : cursor;
    if (!next) return;
    try {
      const page = await api<Companies>(`${path}&cursor=${encodeURIComponent(next)}`, {
        workspaceId,
      });
      setExtra((rows) => [...rows, ...page.data]);
      setCursor(page.next_cursor);
    } catch (err) {
      setError(err);
    }
  }

  function applySearch(e: FormEvent) {
    e.preventDefault();
    setExtra([]);
    setCursor(undefined);
    setSearch(query.trim());
  }

  const rows = [...(list.data?.data ?? []), ...extra];
  const hasMore = cursor === undefined ? (list.data?.has_more ?? false) : cursor !== null;

  return (
    <>
      <h1>Companies</h1>
      <section aria-labelledby="submit-domain" className="card">
        <h2 id="submit-domain">Research a company</h2>
        <form onSubmit={submit} className="form-row">
          <label htmlFor="domain">Company domain</label>
          <input
            id="domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="example.com"
            required
            maxLength={253}
            inputMode="url"
            aria-describedby="domain-help"
          />
          <button type="submit" className="button button-primary" disabled={busy || !domain.trim()}>
            {busy ? 'Adding…' : 'Add company'}
          </button>
        </form>
        <p id="domain-help" className="muted small">
          Public company domains only. Submitting an existing domain opens its record.
        </p>
        <ErrorNotice error={error} />
      </section>

      <section aria-labelledby="company-list" className="card">
        <div className="section-head">
          <h2 id="company-list">All companies</h2>
          <form onSubmit={applySearch} role="search" className="form-inline">
            <label htmlFor="company-search" className="visually-hidden">
              Search companies
            </label>
            <input
              id="company-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or domain"
            />
            <button type="submit" className="button">
              Search
            </button>
          </form>
        </div>
        {list.loading ? <Loading /> : null}
        <ErrorNotice error={list.error} />
        {list.data && rows.length === 0 ? <Empty>No companies yet.</Empty> : null}
        {rows.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Domain</th>
                <th scope="col">Industry</th>
                <th scope="col">Country</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/w/${workspaceId}/companies/${c.id}`}>{c.canonical_name}</Link>
                  </td>
                  <td>{c.primary_domain}</td>
                  <td>{c.industry ?? <span className="muted">Unknown</span>}</td>
                  <td>{c.country_code ?? <span className="muted">Unknown</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {hasMore ? (
          <button type="button" className="button" onClick={loadMore}>
            Load more
          </button>
        ) : null}
      </section>
    </>
  );
}
