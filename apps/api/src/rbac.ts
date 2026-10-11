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
  | 'audit.read';

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
  'audit.read': ['owner', 'admin', 'manager', 'auditor'],
};

export function can(role: MembershipRole, permission: Permission): boolean {
  return MATRIX[permission].includes(role);
}

export const PERMISSIONS = Object.keys(MATRIX) as Permission[];
