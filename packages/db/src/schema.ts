import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** pg returns NUMERIC as string to avoid precision loss. */
type Numeric = ColumnType<string, string | number, string | number>;
type NullableNumeric = ColumnType<string | null, string | number | null, string | number | null>;
type Json = ColumnType<unknown, string, string>;

export type MembershipRole =
  'owner' | 'admin' | 'manager' | 'researcher' | 'representative' | 'auditor';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'partial_success'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled';

export type SourceStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
export type ClaimType = 'source_fact' | 'provider_fact' | 'model_inference' | 'user_assertion';
export type RelationshipStatus = 'verified' | 'inferred' | 'disputed' | 'expired';
export type ReviewStatus = 'unreviewed' | 'accepted' | 'rejected' | 'disputed';

export interface UsersTable {
  id: Generated<string>;
  idp_issuer: string;
  idp_subject: string;
  email: string;
  display_name: string | null;
  status: Generated<'active' | 'disabled'>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface SessionsTable {
  id: Generated<string>;
  token_hash: Buffer;
  user_id: string;
  created_at: GeneratedTimestamp;
  last_seen_at: GeneratedTimestamp;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface TenantsTable {
  id: string;
  name: string;
  plan_id: Generated<string>;
  status: Generated<'active' | 'suspended'>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface MembershipsTable {
  tenant_id: string;
  user_id: string;
  role: MembershipRole;
  status: Generated<'active' | 'suspended'>;
  created_at: GeneratedTimestamp;
}

export interface AuditEventsTable {
  id: Generated<string>;
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_type: 'user' | 'system';
  action: string;
  entity_type: string;
  entity_id: string | null;
  outcome: 'success' | 'denied' | 'failure';
  correlation_id: string;
  metadata: Json;
  created_at: GeneratedTimestamp;
}

export interface OutboxEventsTable {
  id: string;
  tenant_id: string;
  event_type: string;
  schema_version: Generated<number>;
  correlation_id: string;
  causation_id: string | null;
  idempotency_key: string;
  payload: Json;
  occurred_at: GeneratedTimestamp;
  published_at: Timestamp | null;
  attempts: Generated<number>;
  next_attempt_at: GeneratedTimestamp;
  last_error: string | null;
  dead_lettered_at: Timestamp | null;
}

export interface IdempotencyKeysTable {
  tenant_id: string;
  key: string;
  user_id: string;
  method: string;
  route: string;
  request_hash: string;
  response_status: number | null;
  response_body: Json | null;
  created_at: GeneratedTimestamp;
  expires_at: Timestamp;
}

export interface IcpProfilesTable {
  id: Generated<string>;
  tenant_id: string;
  profile_key: string;
  name: string;
  version: number;
  definition: Json;
  active: Generated<boolean>;
  created_by: string;
  created_at: GeneratedTimestamp;
}

export interface SourceRegistryTable {
  id: string;
  provider_name: string;
  source_type: string;
  terms_reference: string;
  allowed_purposes: string[];
  retention_policy: string;
  enabled: boolean;
  is_mock: boolean;
  config: Json;
  created_at: GeneratedTimestamp;
}

export interface CompaniesTable {
  id: Generated<string>;
  tenant_id: string;
  canonical_name: string;
  primary_domain: string;
  country_code: string | null;
  region: string | null;
  industry: string | null;
  employee_band: string | null;
  description: string | null;
  lifecycle_status: Generated<'active' | 'archived'>;
  created_by: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  version: Generated<number>;
}

export interface WorkflowJobsTable {
  id: Generated<string>;
  tenant_id: string;
  company_id: string;
  job_type: 'company_research';
  status: Generated<JobStatus>;
  idempotency_key: string;
  input: Json;
  result: Json | null;
  requested_by: string;
  temporal_workflow_id: string;
  cost_estimate: NullableNumeric;
  cost_actual: NullableNumeric;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  error_code: string | null;
  error_summary: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  version: Generated<number>;
}

export interface WorkflowJobSourcesTable {
  job_id: string;
  tenant_id: string;
  source_key: string;
  status: Generated<SourceStatus>;
  attempts: Generated<number>;
  evidence_count: Generated<number>;
  error_code: string | null;
  error_summary: string | null;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

export interface ProviderUsageTable {
  id: Generated<string>;
  tenant_id: string;
  workflow_job_id: string | null;
  provider: string;
  source_key: string;
  operation: string;
  request_count: number;
  units: Numeric;
  unit_type: string;
  estimated_cost: NullableNumeric;
  actual_cost: NullableNumeric;
  status: 'succeeded' | 'failed';
  occurred_at: GeneratedTimestamp;
}

export interface EvidenceRecordsTable {
  id: Generated<string>;
  tenant_id: string;
  company_id: string | null;
  source_registry_id: string;
  workflow_job_id: string | null;
  source_url: string;
  fetched_at: Timestamp;
  published_at: Timestamp | null;
  content_hash: string;
  content_type: string;
  storage_key: string | null;
  excerpt: string | null;
  license_metadata: Json;
  retention_until: Timestamp | null;
  created_at: GeneratedTimestamp;
}

export interface ClaimsTable {
  id: Generated<string>;
  tenant_id: string;
  subject_type: 'company' | 'person' | 'employment_role';
  subject_id: string;
  predicate: string;
  object_value: Json;
  claim_type: ClaimType;
  status: Generated<'current' | 'disputed' | 'expired' | 'retracted'>;
  confidence: Numeric;
  rationale: string | null;
  source_key: string | null;
  workflow_job_id: string | null;
  observed_at: Timestamp;
  valid_from: Timestamp | null;
  valid_to: Timestamp | null;
  created_at: GeneratedTimestamp;
}

export interface ClaimEvidenceTable {
  claim_id: string;
  evidence_record_id: string;
  tenant_id: string;
  support_type: Generated<'supports' | 'contradicts'>;
  excerpt_locator: string | null;
}

export interface PeopleTable {
  id: Generated<string>;
  tenant_id: string;
  canonical_name: string;
  normalized_name: string;
  public_profile_url: string | null;
  review_status: Generated<ReviewStatus>;
  reviewed_by: string | null;
  reviewed_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  version: Generated<number>;
}

export interface EmploymentRolesTable {
  id: Generated<string>;
  tenant_id: string;
  person_id: string;
  company_id: string;
  title: string | null;
  department: string | null;
  seniority: string | null;
  start_date: string | null;
  end_date: string | null;
  status: Generated<'current' | 'past' | 'unknown'>;
  created_at: GeneratedTimestamp;
}

export interface PersonCompanyLinksTable {
  id: Generated<string>;
  tenant_id: string;
  person_id: string;
  company_id: string;
  relationship_status: 'current' | 'past' | 'unknown';
  confidence: Numeric;
  valid_from: Timestamp | null;
  valid_to: Timestamp | null;
  created_at: GeneratedTimestamp;
}

export interface PersonReviewsTable {
  id: Generated<string>;
  tenant_id: string;
  person_id: string;
  decision: 'accepted' | 'rejected' | 'disputed';
  reason: string | null;
  actor_user_id: string;
  created_at: GeneratedTimestamp;
}

export interface RelationshipsTable {
  id: Generated<string>;
  tenant_id: string;
  subject_type: 'person' | 'company';
  subject_id: string;
  predicate: string;
  object_type: 'person' | 'company' | 'technology' | 'role';
  object_id: string;
  status: RelationshipStatus;
  claim_type: ClaimType;
  confidence: Numeric;
  rationale: string;
  source_key: string | null;
  workflow_job_id: string | null;
  valid_from: Timestamp | null;
  valid_to: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RelationshipEvidenceTable {
  relationship_id: string;
  evidence_record_id: string;
  tenant_id: string;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  tenants: TenantsTable;
  memberships: MembershipsTable;
  audit_events: AuditEventsTable;
  outbox_events: OutboxEventsTable;
  idempotency_keys: IdempotencyKeysTable;
  icp_profiles: IcpProfilesTable;
  source_registry: SourceRegistryTable;
  companies: CompaniesTable;
  workflow_jobs: WorkflowJobsTable;
  workflow_job_sources: WorkflowJobSourcesTable;
  provider_usage: ProviderUsageTable;
  evidence_records: EvidenceRecordsTable;
  claims: ClaimsTable;
  claim_evidence: ClaimEvidenceTable;
  people: PeopleTable;
  employment_roles: EmploymentRolesTable;
  person_company_links: PersonCompanyLinksTable;
  person_reviews: PersonReviewsTable;
  relationships: RelationshipsTable;
  relationship_evidence: RelationshipEvidenceTable;
}
