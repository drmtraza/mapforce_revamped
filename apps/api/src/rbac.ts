import type { MembershipRole } from '@mapforce/db';

export type Permission =
  | 'workspace.read'
  | 'members.read'
  | 'icp.read'
  | 'icp.write'
  | 'company.read'
  | 'company.write'
  | 'research.start'
  | 'research.cancel'
  | 'evidence.read'
  | 'people.read'
  | 'people.review'
  | 'orgmap.run'
  | 'people.merge'
  | 'enrich.start'
  | 'suppression.read'
  | 'suppression.write'
  | 'audit.read'
  | 'source.read'
  | 'source.manage'
  | 'discovery.start'
  | 'import.read'
  | 'import.write'
  | 'outbox.manage'
  | 'score.run'
  | 'list.read'
  | 'list.write'
  | 'account.assign'
  | 'task.write'
  | 'note.write'
  | 'export.start'
  | 'usage.read'
  | 'budget.manage'
  | 'ops.read'
  | 'ops.manage';

const ALL: MembershipRole[] = [
  'owner',
  'admin',
  'manager',
  'researcher',
  'representative',
  'auditor',
];

const MATRIX: Record<Permission, readonly MembershipRole[]> = {
  'workspace.read': ALL,
  'members.read': ALL,
  'icp.read': ALL,
  'icp.write': ['owner', 'admin', 'manager'],
  'company.read': ALL,
  'company.write': ['owner', 'admin', 'manager', 'researcher', 'representative'],
  'research.start': ['owner', 'admin', 'manager', 'researcher', 'representative'],
  'research.cancel': ['owner', 'admin', 'manager', 'researcher'],
  'evidence.read': ALL,
  'people.read': ALL,
  'people.review': ['owner', 'admin', 'manager', 'researcher'],
  'orgmap.run': ['owner', 'admin', 'manager', 'researcher'],
  'people.merge': ['owner', 'admin', 'manager', 'researcher'],
  'enrich.start': ['owner', 'admin', 'manager', 'researcher'],
  'suppression.read': ALL,
  'suppression.write': ['owner', 'admin', 'manager'],
  'audit.read': ['owner', 'admin', 'manager', 'auditor'],
  'source.read': ALL,
  'source.manage': ['owner', 'admin'],
  'discovery.start': ['owner', 'admin', 'manager', 'researcher', 'representative'],
  'import.read': ALL,
  'import.write': ['owner', 'admin', 'manager', 'researcher'],
  'outbox.manage': ['owner', 'admin'],
  'score.run': ['owner', 'admin', 'manager', 'researcher'],
  'list.read': ALL,
  'list.write': ['owner', 'admin', 'manager', 'researcher', 'representative'],
  'account.assign': ['owner', 'admin', 'manager'],
  'task.write': ['owner', 'admin', 'manager', 'researcher', 'representative'],
  'note.write': ['owner', 'admin', 'manager', 'researcher', 'representative'],
  'export.start': ['owner', 'admin', 'manager'],
  'usage.read': ['owner', 'admin', 'manager', 'auditor'],
  'budget.manage': ['owner', 'admin'],
  'ops.read': ['owner', 'admin', 'manager', 'auditor'],
  'ops.manage': ['owner', 'admin'],
};

export function can(role: MembershipRole, permission: Permission): boolean {
  return MATRIX[permission].includes(role);
}

export const PERMISSIONS = Object.keys(MATRIX) as Permission[];
