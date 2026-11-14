'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { StatusBadge } from '@/components/badges';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type Offering = {
  id: string;
  name: string;
  category: string;
  description: string;
  business_problem: string;
  target_industries: string[];
  target_countries: string[];
  employee_bands: string[];
  target_personas: string[];
  pricing_model: string;
  price_range_note: string | null;
  status: string;
  version: number;
};

export default function CataloguePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const role = useWorkspaceRole(workspaceId);
  const offerings = useApi<{ data: Offering[]; note: string }>(
    '/api/v1/product-offerings',
    workspaceId,
  );
  const canWrite = allowed(role, 'writeCatalogue');
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('cybersecurity');
  const [description, setDescription] = useState('');
  const [problem, setProblem] = useState('');
  const [industries, setIndustries] = useState('financial_services');
  const [countries, setCountries] = useState('SA,GB,US');
  const [priceNote, setPriceNote] = useState('');

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/v1/product-offerings', {
        method: 'POST',
        workspaceId,
        body: {
          name,
          category,
          description,
          business_problem: problem,
          target_industries: industries
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          target_countries: countries
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          employee_bands: [],
          target_personas: ['economic_buyer', 'technical_evaluator'],
          pricing_model: 'unspecified',
          price_range_note: priceNote.trim() || null,
          status: 'active',
        },
      });
      setName('');
      setDescription('');
      setProblem('');
      setPriceNote('');
      offerings.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <>
      <h1>Product &amp; services catalogue</h1>
      <p className="muted small">
        Workspace-authored offerings for opportunity matching. Price notes must be human-entered —
        AI must not invent prices or certifications. Match scores are separate from ICP account
        scores.
      </p>
      <ErrorNotice error={offerings.error ?? error} />
      {offerings.loading && !offerings.data ? <Loading /> : null}
      {offerings.data?.note ? <p className="muted small">{offerings.data.note}</p> : null}

      {canWrite ? (
        <section className="card" aria-labelledby="add-offering">
          <h2 id="add-offering">Add offering</h2>
          <form onSubmit={create}>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>
              Category
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {(
                  [
                    'cybersecurity',
                    'cloud',
                    'ai_automation',
                    'saas',
                    'software',
                    'consulting',
                    'professional_services',
                    'training',
                    'distribution',
                    'custom_enterprise',
                    'product',
                    'other',
                  ] as const
                ).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Description
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                required
              />
            </label>
            <label>
              Business problem solved
              <textarea
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
                rows={2}
                required
              />
            </label>
            <label>
              Target industries (comma-separated)
              <input value={industries} onChange={(e) => setIndustries(e.target.value)} />
            </label>
            <label>
              Target countries (ISO codes, comma-separated)
              <input value={countries} onChange={(e) => setCountries(e.target.value)} />
            </label>
            <label>
              Indicative price range note (optional, human-authored)
              <input value={priceNote} onChange={(e) => setPriceNote(e.target.value)} />
            </label>
            <button type="submit" className="button">
              Save offering
            </button>
          </form>
        </section>
      ) : null}

      <section className="card" aria-labelledby="offerings">
        <h2 id="offerings">Active catalogue</h2>
        {!offerings.data?.data.length ? <Empty>No offerings yet.</Empty> : null}
        <ul className="list">
          {(offerings.data?.data ?? []).map((o) => (
            <li key={o.id}>
              <p>
                <strong>{o.name}</strong> <StatusBadge status={o.category} />{' '}
                <StatusBadge status={o.status} />
              </p>
              <p className="muted small">{o.business_problem}</p>
              <p className="muted small">
                Industries: {o.target_industries.join(', ') || 'any'} · Countries:{' '}
                {o.target_countries.join(', ') || 'any'}
                {o.price_range_note ? ` · ${o.price_range_note}` : ''}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
