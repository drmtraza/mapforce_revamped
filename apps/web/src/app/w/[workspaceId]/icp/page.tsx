'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api, type ApiResponse } from '@/lib/api';
import { useApi } from '@/lib/use-api';

type Profiles = ApiResponse<'/api/v1/icp-profiles', 'get'>;
type Profile = Profiles['data'][number];
type Persona = Profile['definition']['target_personas'][number];
type Band = Profile['definition']['employee_bands'][number];

const PERSONAS: { value: Persona; label: string }[] = [
  { value: 'economic_buyer', label: 'Economic buyer' },
  { value: 'functional_champion', label: 'Functional champion' },
  { value: 'technical_evaluator', label: 'Technical evaluator' },
  { value: 'operational_user', label: 'Operational user' },
  { value: 'procurement', label: 'Procurement' },
];
const BANDS: Band[] = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001+'];
const EUROPE = [
  'AT',
  'BE',
  'BG',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IS',
  'IT',
  'LI',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
];
const PRESETS: { label: string; codes: string[] }[] = [
  { label: 'United States', codes: ['US'] },
  { label: 'United Kingdom', codes: ['GB'] },
  { label: 'EU / EEA + Switzerland', codes: EUROPE },
];

const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

interface Draft {
  name: string;
  industries: string;
  countries: string;
  titles: string;
  personas: Persona[];
  bands: Band[];
}

const EMPTY: Draft = {
  name: '',
  industries: '',
  countries: '',
  titles: '',
  personas: [],
  bands: [],
};

function toDraft(p: Profile): Draft {
  return {
    name: p.name,
    industries: p.definition.industries.join(', '),
    countries: p.definition.countries.join(', '),
    titles: p.definition.target_titles.join(', '),
    personas: p.definition.target_personas,
    bands: p.definition.employee_bands,
  };
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export default function IcpPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const list = useApi<Profiles>('/api/v1/icp-profiles', workspaceId);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function startEdit(p: Profile) {
    setEditing(p);
    setDraft(toDraft(p));
    setError(null);
  }

  function addCountries(codes: string[]) {
    const merged = new Set([...splitList(draft.countries).map((c) => c.toUpperCase()), ...codes]);
    setDraft({ ...draft, countries: [...merged].join(', ') });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const definition = {
      industries: splitList(draft.industries),
      countries: splitList(draft.countries).map((c) => c.toUpperCase()),
      target_titles: splitList(draft.titles),
      target_personas: draft.personas,
      employee_bands: draft.bands,
    };
    try {
      if (editing) {
        await api(`/api/v1/icp-profiles/${editing.id}`, {
          method: 'PATCH',
          workspaceId,
          body: { expected_version: editing.version, name: draft.name.trim(), definition },
        });
      } else {
        await api('/api/v1/icp-profiles', {
          method: 'POST',
          workspaceId,
          body: { name: draft.name.trim(), definition },
        });
      }
      setEditing(null);
      setDraft(EMPTY);
      list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Ideal customer profiles</h1>
      <section aria-labelledby="icp-list" className="card">
        <h2 id="icp-list">Active profiles</h2>
        {list.loading ? <Loading /> : null}
        <ErrorNotice error={list.error} />
        {list.data && list.data.data.length === 0 ? <Empty>No profiles yet.</Empty> : null}
        <ul className="list">
          {list.data?.data.map((p) => (
            <li key={p.id} className="icp">
              <p>
                <strong>{p.name}</strong> <span className="muted small">version {p.version}</span>{' '}
                <button type="button" className="button button-quiet" onClick={() => startEdit(p)}>
                  Edit <span className="visually-hidden">{p.name}</span>
                </button>
              </p>
              <dl className="facts small">
                <dt>Industries</dt>
                <dd>{p.definition.industries.join(', ') || 'Any'}</dd>
                <dt>Countries</dt>
                <dd>{p.definition.countries.join(', ') || 'Any'}</dd>
                <dt>Company size</dt>
                <dd>{p.definition.employee_bands.join(', ') || 'Any'}</dd>
                <dt>Personas</dt>
                <dd>
                  {p.definition.target_personas
                    .map((v) => PERSONAS.find((x) => x.value === v)?.label ?? v)
                    .join(', ') || 'Any'}
                </dd>
                <dt>Titles</dt>
                <dd>{p.definition.target_titles.join(', ') || 'Any'}</dd>
              </dl>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="icp-form" className="card">
        <h2 id="icp-form">{editing ? `Edit ${editing.name}` : 'New profile'}</h2>
        {editing ? (
          <p className="muted small">Saving creates version {editing.version + 1}.</p>
        ) : null}
        <form onSubmit={save} className="form-stack">
          <label htmlFor="icp-name">Name</label>
          <input
            id="icp-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
            maxLength={120}
          />

          <label htmlFor="icp-industries">Industries (comma separated)</label>
          <input
            id="icp-industries"
            value={draft.industries}
            onChange={(e) => setDraft({ ...draft, industries: e.target.value })}
            placeholder="Software, Fintech"
          />

          <label htmlFor="icp-countries">Countries (ISO codes, comma separated)</label>
          <input
            id="icp-countries"
            value={draft.countries}
            onChange={(e) => setDraft({ ...draft, countries: e.target.value })}
            placeholder="US, GB, DE"
            aria-describedby="icp-country-presets"
          />
          <div id="icp-country-presets" className="actions">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="button button-quiet"
                onClick={() => addCountries(p.codes)}
              >
                Add {p.label}
              </button>
            ))}
          </div>

          <fieldset>
            <legend>Company size (employees)</legend>
            <div className="checkbox-grid">
              {BANDS.map((b) => (
                <label key={b} className="checkbox">
                  <input
                    type="checkbox"
                    checked={draft.bands.includes(b)}
                    onChange={() => setDraft({ ...draft, bands: toggle(draft.bands, b) })}
                  />
                  {b}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>Buying-committee personas</legend>
            <div className="checkbox-grid">
              {PERSONAS.map((p) => (
                <label key={p.value} className="checkbox">
                  <input
                    type="checkbox"
                    checked={draft.personas.includes(p.value)}
                    onChange={() =>
                      setDraft({ ...draft, personas: toggle(draft.personas, p.value) })
                    }
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label htmlFor="icp-titles">Target titles (comma separated)</label>
          <input
            id="icp-titles"
            value={draft.titles}
            onChange={(e) => setDraft({ ...draft, titles: e.target.value })}
            placeholder="VP Engineering, Head of Procurement"
          />

          <div className="actions">
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save new version' : 'Create profile'}
            </button>
            {editing ? (
              <button
                type="button"
                className="button"
                onClick={() => {
                  setEditing(null);
                  setDraft(EMPTY);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
          <ErrorNotice error={error} />
        </form>
      </section>
    </>
  );
}
