'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback } from 'react';
import type { OrgMapV2 } from '@mapforce/contracts';
import { ClaimTypeBadge, ConfidenceBadge, StatusBadge } from '@/components/badges';
import { EvidenceList, formatDate } from '@/components/evidence-list';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { OrgMapView } from '@/components/org-map';
import { ResearchPanel } from '@/components/research-panel';
import type { ApiResponse } from '@/lib/api';
import { useApi } from '@/lib/use-api';

type Company = ApiResponse<'/api/v1/companies/{id}', 'get'>;
type Evidence = ApiResponse<'/api/v1/companies/{id}/evidence', 'get'>;
type People = ApiResponse<'/api/v1/companies/{id}/people', 'get'>;
type Freshness = ApiResponse<'/api/v1/companies/{id}/source-freshness', 'get'>;
type Signals = ApiResponse<'/api/v1/companies/{id}/signals', 'get'>;

export default function CompanyPage() {
  const { workspaceId, companyId } = useParams<{ workspaceId: string; companyId: string }>();
  const base = `/api/v1/companies/${companyId}`;
  const company = useApi<Company>(base, workspaceId);
  const evidence = useApi<Evidence>(`${base}/evidence?limit=100`, workspaceId);
  const people = useApi<People>(`${base}/people`, workspaceId);
  const orgMap = useApi<OrgMapV2>(`${base}/org-map`, workspaceId);
  const freshness = useApi<Freshness>(`${base}/source-freshness`, workspaceId);
  const signals = useApi<Signals>(`${base}/signals`, workspaceId);

  const { reload: reloadCompany } = company;
  const { reload: reloadEvidence } = evidence;
  const { reload: reloadPeople } = people;
  const { reload: reloadMap } = orgMap;
  const { reload: reloadFreshness } = freshness;
  const { reload: reloadSignals } = signals;
  const refresh = useCallback(() => {
    reloadCompany();
    reloadEvidence();
    reloadPeople();
    reloadMap();
    reloadFreshness();
    reloadSignals();
  }, [reloadCompany, reloadEvidence, reloadPeople, reloadMap, reloadFreshness, reloadSignals]);

  if (company.loading && !company.data) return <Loading />;
  if (company.error) return <ErrorNotice error={company.error} />;
  if (!company.data) return null;
  const c = company.data.company;

  return (
    <>
      <p className="breadcrumb">
        <Link href={`/w/${workspaceId}/companies`}>Companies</Link> / {c.canonical_name}
      </p>
      <h1>{c.canonical_name}</h1>
      <section aria-labelledby="profile" className="card">
        <h2 id="profile">Profile</h2>
        <dl className="facts">
          <dt>Domain</dt>
          <dd>{c.primary_domain}</dd>
          <dt>Industry</dt>
          <dd>{c.industry ?? <span className="muted">Unknown</span>}</dd>
          <dt>Country</dt>
          <dd>{c.country_code ?? <span className="muted">Unknown</span>}</dd>
          <dt>Employees</dt>
          <dd>{c.employee_band ?? <span className="muted">Unknown</span>}</dd>
          <dt>Description</dt>
          <dd>{c.description ?? <span className="muted">Not collected yet</span>}</dd>
        </dl>
        <p className="muted small">
          Profile fields come from cited evidence below. {company.data.counts.evidence} evidence
          records · {company.data.counts.people} candidate people.
        </p>
      </section>

      <section aria-labelledby="freshness" className="card">
        <h2 id="freshness">Source freshness</h2>
        <p className="muted small">
          A source is stale when it has never succeeded for this company, or the last success is
          older than its freshness window.
        </p>
        <ErrorNotice error={freshness.error} />
        {freshness.data ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Last success</th>
                <th scope="col">Window</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {freshness.data.data.map((f) => (
                <tr key={f.source_key}>
                  <td>{f.provider_name}</td>
                  <td>
                    {f.last_success_at ? (
                      formatDate(f.last_success_at)
                    ) : (
                      <span className="muted">Never</span>
                    )}
                  </td>
                  <td>{f.freshness_ttl_hours}h</td>
                  <td>
                    <StatusBadge status={f.stale ? 'stale' : 'fresh'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <ResearchPanel
        workspaceId={workspaceId}
        companyId={companyId}
        initialJobId={company.data.latest_job?.id ?? null}
        onFinished={refresh}
      />

      <section aria-labelledby="signals" className="card">
        <h2 id="signals">Signals</h2>
        <p className="muted small">
          Hiring activity is not evidence of budget. Every signal cites its source.
        </p>
        <ErrorNotice error={signals.error} />
        {signals.data && signals.data.data.length === 0 ? <Empty>No signals yet.</Empty> : null}
        {signals.data && signals.data.data.length > 0 ? (
          <ul className="list">
            {signals.data.data.map((s) => (
              <li key={s.id} className="claim">
                <p>
                  <strong>{s.title}</strong> <StatusBadge status={s.signal_type} />{' '}
                  <ClaimTypeBadge type={s.claim_type} />
                </p>
                <p>{s.summary}</p>
                <p className="muted small">
                  Implies budget: {s.implies_budget ? 'yes' : 'no'}
                  {s.country_code ? ` · ${s.country_code}` : ''} · {formatDate(s.observed_at)}
                </p>
                {s.evidence.map((e) => (
                  <p key={e.id} className="muted small">
                    <a href={e.source_url} target="_blank" rel="noopener noreferrer nofollow">
                      {e.source_url}
                    </a>
                    {e.excerpt ? ` — ${e.excerpt}` : ''}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="people" className="card">
        <h2 id="people">Candidate people</h2>
        <p className="muted small">
          Candidates are unverified until a reviewer confirms them. Confidence is a heuristic, not a
          probability.
        </p>
        <ErrorNotice error={people.error} />
        {people.data && people.data.data.length === 0 ? (
          <Empty>No candidate people yet.</Empty>
        ) : null}
        {people.data && people.data.data.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Title</th>
                <th scope="col">Confidence</th>
                <th scope="col">Review</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {people.data.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/w/${workspaceId}/people/${p.id}`}>{p.canonical_name}</Link>
                  </td>
                  <td>{p.title ?? <span className="muted">Unknown</span>}</td>
                  <td>
                    <ConfidenceBadge confidence={p.confidence} />
                  </td>
                  <td>
                    <StatusBadge status={p.review_status} />
                  </td>
                  <td>{p.evidence_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section aria-labelledby="org" className="card">
        <h2 id="org">Organization map</h2>
        <ErrorNotice error={orgMap.error} />
        {orgMap.data ? <OrgMapView map={orgMap.data} workspaceId={workspaceId} /> : null}
      </section>

      <section aria-labelledby="evidence" className="card">
        <h2 id="evidence">Evidence</h2>
        <ErrorNotice error={evidence.error} />
        {evidence.data ? (
          <EvidenceList workspaceId={workspaceId} items={evidence.data.data} />
        ) : null}
      </section>
    </>
  );
}
