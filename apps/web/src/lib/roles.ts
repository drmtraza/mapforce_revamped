import type { WorkspaceRole } from './use-api';

/** Mirrors the API permission matrix for hiding controls only; the API stays authoritative. */
const ROLES = {
  manageSources: ['owner', 'admin'],
  manageDeadLetters: ['owner', 'admin'],
  startDiscovery: ['owner', 'admin', 'manager', 'researcher', 'representative'],
  cancelJobs: ['owner', 'admin', 'manager', 'researcher'],
  writeCompanies: ['owner', 'admin', 'manager', 'researcher', 'representative'],
  writeImports: ['owner', 'admin', 'manager', 'researcher'],
} as const satisfies Record<string, readonly WorkspaceRole[]>;

export function allowed(role: WorkspaceRole | null, action: keyof typeof ROLES): boolean {
  return role !== null && (ROLES[action] as readonly WorkspaceRole[]).includes(role);
}
