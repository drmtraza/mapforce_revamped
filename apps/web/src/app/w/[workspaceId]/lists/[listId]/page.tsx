'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Empty, ErrorNotice, Loading } from '@/components/feedback';
import { api } from '@/lib/api';
import { allowed } from '@/lib/roles';
import { useApi, useWorkspaceRole } from '@/lib/use-api';

type Detail = {
  list: { id: string; name: string; kind: string; item_count: number };
  items: { id: string; entity_type: string; entity_id: string; display_name: string }[];
};

export default function ListDetailPage() {
  const { workspaceId, listId } = useParams<{ workspaceId: string; listId: string }>();
  const role = useWorkspaceRole(workspaceId);
  const detail = useApi<Detail>(`/api/v1/lists/${listId}`, workspaceId);
  const canWrite = allowed(role, 'writeLists');

  async function remove(itemId: string) {
    await api(`/api/v1/lists/${listId}/items/${itemId}`, { method: 'DELETE', workspaceId });
    detail.reload();
  }

  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (!detail.data) return null;

  return (
    <>
      <p className="breadcrumb">
        <Link href={`/w/${workspaceId}/lists`}>Lists</Link> / {detail.data.list.name}
      </p>
      <h1>{detail.data.list.name}</h1>
      <p className="muted small">{detail.data.list.item_count} items</p>
      {detail.data.items.length === 0 ? <Empty>No items yet.</Empty> : null}
      <ul className="list">
        {detail.data.items.map((i) => (
          <li key={i.id}>
            {i.entity_type === 'company' ? (
              <Link href={`/w/${workspaceId}/companies/${i.entity_id}`}>{i.display_name}</Link>
            ) : (
              <Link href={`/w/${workspaceId}/people/${i.entity_id}`}>{i.display_name}</Link>
            )}
            {canWrite ? (
              <button type="button" className="button" onClick={() => remove(i.id)}>
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
