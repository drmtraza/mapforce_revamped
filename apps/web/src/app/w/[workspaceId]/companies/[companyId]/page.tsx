'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback } from 'react';
import type { OrgMapV2 } from '@mapforce/contracts';
import { ConfidenceBadge, StatusBadge } from '@/components/badges';
import { EvidenceList } from '@/components/evidence-list';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { OrgMapView } from '@/components/org-map';
import { ResearchPanel } from '@/components/research-panel';
import type { ApiResponse } from '@/lib/api';
import { useApi } from '@/lib/use-api';

type Company = ApiResponse<'/api/v1/companies/{id}', 'get'>;
type Evidence = ApiResponse<'/api/v1/companies/{id}/evidence', 'get'>;
type People = ApiResponse<'/api/v1/companies/{id}/people', 'get'>;

export default function CompanyPage() {
  const { workspaceId, companyId } = useParams<{ workspaceId: string; companyId: string }>();
  const base = `/api/v1/companies/${companyId}`;
  const company = useApi<Company>(base, workspaceId);
  const evidence = useApi<Evidence>(`${base}/evidence?limit=100`, workspaceId);
  const people = useApi<People>(`${base}/people`, workspaceId);
  const orgMap = useApi<OrgMapV2>(`${base}/org-map`, workspaceId);

  const { reload: reloadCompany } = company;
  const { reload: reloadEvidence } = evidence;
  const { reload: reloadPeople } = people;
  const { reload: reloadMap } = orgMap;
  const refresh = useCallback(() => {
    reloadCompany();
    reloadEvidence();
    reloadPeople();
    reloadMap();
  }, [reloadCompany, reloadEvidence, reloadPeople, reloadMap]);

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

      <ResearchPanel
        workspaceId={workspaceId}
        companyId={companyId}
        initialJobId={company.data.latest_job?.id ?? null}
        onFinished={refresh}
      />

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
