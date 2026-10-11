import type { WorkspaceRole } from './use-api';

/** Mirrors the API permission matrix for hiding controls only; the API stays authoritative. */
const ROLES = {
  manageSources: ['owner', 'admin'],
  manageDeadLetters: ['owner', 'admin'],
  startDiscovery: ['owner', 'admin', 'manager', 'researcher', 'representative'],
  cancelJobs: ['owner', 'admin', 'manager', 'researcher'],
  writeCompanies: ['owner', 'admin', 'manager', 'researcher', 'representative'],
  writeImports: ['owner', 'admin', 'manager', 'researcher'],
  reviewPeople: ['owner', 'admin', 'manager', 'researcher'],
  mergePeople: ['owner', 'admin', 'manager', 'researcher'],
  startEnrich: ['owner', 'admin', 'manager', 'researcher'],
  runOrgMap: ['owner', 'admin', 'manager', 'researcher'],
  writeSuppression: ['owner', 'admin', 'manager'],
  runScore: ['owner', 'admin', 'manager', 'researcher'],
  writeLists: ['owner', 'admin', 'manager', 'researcher', 'representative'],
  assignAccounts: ['owner', 'admin', 'manager'],
  writeCrm: ['owner', 'admin', 'manager', 'researcher', 'representative'],
  startExport: ['owner', 'admin', 'manager'],
  readUsage: ['owner', 'admin', 'manager', 'auditor'],
  manageBudget: ['owner', 'admin'],
} as const satisfies Record<string, readonly WorkspaceRole[]>;

export function allowed(role: WorkspaceRole | null, action: keyof typeof ROLES): boolean {
  return role !== null && (ROLES[action] as readonly WorkspaceRole[]).includes(role);
}
