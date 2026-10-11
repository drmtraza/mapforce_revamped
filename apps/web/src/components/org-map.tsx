'use client';

import Link from 'next/link';
import type { OrgMapPerson, OrgMapRelationship, OrgMapV2 } from '@mapforce/contracts';
import { ClaimTypeBadge, StatusBadge } from './badges';
import { Empty } from './feedback';

const NODE_W = 180;
const NODE_H = 72;

const PERSONA_LABEL: Record<string, string> = {
  economic_buyer: 'Economic buyer',
  functional_champion: 'Champion',
  technical_evaluator: 'Technical eval',
  operational_user: 'Operator',
  procurement: 'Procurement',
  unknown: 'Persona unknown',
};
const GAP_X = 32;
const GAP_Y = 72;
const PAD = 16;

const PREDICATE_LABEL: Record<string, string> = {
  REPORTS_TO: 'reports to',
  INFLUENCES: 'influences',
  DECIDES_FOR: 'decides for',
  WORKS_WITH: 'works with',
};

/** Depth = length of the longest REPORTS_TO chain above a person (cycle-safe). */
export function computeLevels(people: OrgMapPerson[], rels: OrgMapRelationship[]) {
  const managers = new Map<string, string[]>();
  for (const r of rels) {
    if (r.predicate !== 'REPORTS_TO' || r.status === 'expired') continue;
    managers.set(r.subject_person_id, [
      ...(managers.get(r.subject_person_id) ?? []),
      r.object_person_id,
    ]);
  }
  const memo = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const ups = managers.get(id) ?? [];
    const d = ups.length ? 1 + Math.max(...ups.map((m) => depth(m, seen))) : 0;
    seen.delete(id);
    memo.set(id, d);
    return d;
  };
  return new Map(people.map((p) => [p.person_id, depth(p.person_id, new Set())]));
}

function layout(map: OrgMapV2) {
  const levels = computeLevels(map.people, map.relationships);
  const rows = new Map<number, OrgMapPerson[]>();
  for (const p of map.people) {
    const lvl = levels.get(p.person_id) ?? 0;
    rows.set(lvl, [...(rows.get(lvl) ?? []), p]);
  }
  const maxPerRow = Math.max(1, ...[...rows.values()].map((r) => r.length));
  const width = PAD * 2 + maxPerRow * NODE_W + (maxPerRow - 1) * GAP_X;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [lvl, row] of rows) {
    const rowWidth = row.length * NODE_W + (row.length - 1) * GAP_X;
    const start = (width - rowWidth) / 2;
    row
      .sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? ''))
      .forEach((p, i) => {
        pos.set(p.person_id, { x: start + i * (NODE_W + GAP_X), y: PAD + lvl * (NODE_H + GAP_Y) });
      });
  }
  const height = PAD * 2 + rows.size * NODE_H + Math.max(0, rows.size - 1) * GAP_Y;
  return { pos, width, height };
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function OrgMapView({ map, workspaceId }: { map: OrgMapV2; workspaceId: string }) {
  if (map.people.length === 0) {
    return <Empty>{map.unknowns[0] ?? 'No people mapped yet.'}</Empty>;
  }
  const { pos, width, height } = layout(map);
  const name = new Map(map.people.map((p) => [p.person_id, p.display_name ?? 'Unnamed']));

  return (
    <div className="org-map">
      <ul className="legend" aria-label="Legend">
        <li>
          <svg width="40" height="10" aria-hidden="true">
            <line x1="0" y1="5" x2="40" y2="5" className="edge edge-verified" />
          </svg>
          Verified (stated by a cited source)
        </li>
        <li>
          <svg width="40" height="10" aria-hidden="true">
            <line x1="0" y1="5" x2="40" y2="5" className="edge edge-inferred" />
          </svg>
          Inferred (not stated explicitly)
        </li>
      </ul>

      <div className="org-map-canvas">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-labelledby="org-map-title"
        >
          <title id="org-map-title">
            Organization map with {map.people.length} people and {map.relationships.length}{' '}
            relationships. A text version follows.
          </title>
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead" />
            </marker>
          </defs>
          {map.relationships.map((r, i) => {
            const a = pos.get(r.subject_person_id);
            const b = pos.get(r.object_person_id);
            if (!a || !b) return null;
            const up = b.y < a.y;
            const x1 = a.x + NODE_W / 2;
            const y1 = up ? a.y : a.y + NODE_H / 2;
            const x2 = b.x + NODE_W / 2;
            const y2 = up ? b.y + NODE_H : b.y + NODE_H / 2;
            const verified = r.status === 'verified';
            return (
              <line
                key={r.relationship_id ?? i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                className={`edge ${verified ? 'edge-verified' : 'edge-inferred'}`}
                markerEnd="url(#arrow)"
              />
            );
          })}
          {map.people.map((p) => {
            const at = pos.get(p.person_id)!;
            return (
              <g key={p.person_id} transform={`translate(${at.x},${at.y})`}>
                <rect width={NODE_W} height={NODE_H} rx="8" className="node" />
                <text x="10" y="22" className="node-name">
                  {truncate(p.display_name ?? 'Unnamed', 24)}
                </text>
                <text x="10" y="40" className="node-title">
                  {truncate(p.canonical_title ?? 'Title unknown', 28)}
                </text>
                <text x="10" y="58" className="node-persona">
                  {truncate(PERSONA_LABEL[p.persona] ?? p.persona, 26)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <h3>Relationships</h3>
      {map.relationships.length === 0 ? (
        <Empty>No evidence-backed relationships yet.</Empty>
      ) : (
        <ul className="list relationship-list">
          {map.relationships.map((r, i) => (
            <li key={r.relationship_id ?? i}>
              <p>
                <Link href={`/w/${workspaceId}/people/${r.subject_person_id}`}>
                  {name.get(r.subject_person_id)}
                </Link>{' '}
                {PREDICATE_LABEL[r.predicate] ?? r.predicate}{' '}
                <Link href={`/w/${workspaceId}/people/${r.object_person_id}`}>
                  {name.get(r.object_person_id)}
                </Link>{' '}
                <StatusBadge status={r.status} /> <ClaimTypeBadge type={r.claim_type} />{' '}
                <span className="muted small">
                  {Math.round(r.confidence * 100)}% · {r.evidence_ids.length} evidence
                </span>
              </p>
              <p className="muted small">{r.rationale}</p>
            </li>
          ))}
        </ul>
      )}

      {map.unknowns.length || map.conflicts.length ? (
        <>
          <h3>Gaps and conflicts</h3>
          <ul className="list">
            {map.conflicts.map((c) => (
              <li key={c} className="notice notice-warn">
                {c}
              </li>
            ))}
            {map.unknowns.map((u) => (
              <li key={u} className="muted">
                {u}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
