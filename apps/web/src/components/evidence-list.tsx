'use client';

import { useState } from 'react';
import { api, type ApiResponse } from '@/lib/api';
import { MockBadge } from './badges';
import { Empty, ErrorNotice } from './feedback';

type EvidencePage = ApiResponse<'/api/v1/companies/{id}/evidence', 'get'>;
type ContentUrl = ApiResponse<'/api/v1/evidence/{id}/content-url', 'get'>;

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function EvidenceList({
  workspaceId,
  items,
}: {
  workspaceId: string;
  items: EvidencePage['data'];
}) {
  const [error, setError] = useState<unknown>(null);

  async function openStored(id: string) {
    setError(null);
    try {
      const { url } = await api<ContentUrl>(`/api/v1/evidence/${id}/content-url`, {
        workspaceId,
      });
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err);
    }
  }

  if (items.length === 0) return <Empty>No evidence collected yet.</Empty>;
  return (
    <>
      <ErrorNotice error={error} />
      <ul className="list evidence-list">
        {items.map((e) => (
          <li key={e.id} className="evidence">
            <p>
              <a href={e.source_url} target="_blank" rel="noopener noreferrer nofollow">
                {e.source_url}
              </a>{' '}
              {e.is_mock ? <MockBadge /> : null}
            </p>
            <p className="muted small">
              {e.provider_name} ({e.source_type.replace(/_/g, ' ')}) · fetched{' '}
              {formatDate(e.fetched_at)} ·{' '}
              <span title={e.content_hash}>hash {e.content_hash.slice(7, 19)}</span>
            </p>
            {e.excerpt ? <blockquote>{e.excerpt}</blockquote> : null}
            {e.has_stored_content ? (
              <button
                type="button"
                className="button button-quiet"
                onClick={() => openStored(e.id)}
              >
                View stored snapshot
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
