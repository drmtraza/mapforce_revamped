'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppHeader } from '@/components/app-header';

const NAV = [
  { href: 'companies', label: 'Companies' },
  { href: 'pipeline', label: 'Pipeline' },
  { href: 'lists', label: 'Lists' },
  { href: 'discovery', label: 'Discovery' },
  { href: 'imports', label: 'Imports' },
  { href: 'icp', label: 'Ideal customer profiles' },
  { href: 'audit', label: 'Audit trail' },
  { href: 'settings', label: 'Settings' },
];

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const pathname = usePathname();

  return (
    <>
      <AppHeader>
        <nav aria-label="Workspace" className="workspace-nav">
          <ul>
            {NAV.map((item) => {
              const href = `/w/${workspaceId}/${item.href}`;
              const current = pathname.startsWith(href);
              return (
                <li key={item.href}>
                  <Link href={href} aria-current={current ? 'page' : undefined}>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </AppHeader>
      <main id="main" className="page">
        {children}
      </main>
    </>
  );
}
