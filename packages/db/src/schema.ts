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
  description: Generated<string>;
  operations: Generated<string[]>;
  requires_credentials: Generated<boolean>;
  default_tenant_enabled: Generated<boolean>;
  freshness_ttl_hours: Generated<number>;
  retention_days: Generated<number>;
  max_requests_per_job: Generated<number>;
}

export interface TenantSourceSettingsTable {
  tenant_id: string;
  source_key: string;
  enabled: boolean;
  updated_by: string;
  updated_at: GeneratedTimestamp;
}

export type JobType =
  'company_research' | 'company_discovery' | 'person_enrichment' | 'company_orgmap';
export type ContactStatus =
  | 'unverified'
  | 'provider_verified'
  | 'deliverable_likely'
  | 'invalid'
  | 'catch_all'
  | 'unknown'
  | 'suppressed';
export type VerificationMethod = 'none' | 'pattern' | 'mx' | 'provider' | 'user';
export type MatchStatus = 'proposed' | 'accepted' | 'rejected';
export type SignalType = 'hiring' | 'funding' | 'procurement' | 'news' | 'product' | 'other';
export type SuppressionSubject = 'email' | 'phone' | 'domain' | 'person';

export interface DiscoveryCandidatesTable {
  id: Generated<string>;
  tenant_id: string;
  job_id: string;
  source_key: string;
  domain: string;
  name: string;
  country_code: string | null;
  description: string | null;
  claim_type: 'source_fact' | 'provider_fact';
  confidence: Numeric;
  evidence_record_id: string;
  status: Generated<'new' | 'accepted' | 'dismissed'>;
  company_id: string | null;
  decided_by: string | null;
  decided_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

export type ImportOutcome = 'created' | 'existing' | 'duplicate_in_file' | 'invalid';

export interface ImportBatchesTable {
  id: Generated<string>;
  tenant_id: string;
  kind: 'companies';
  idempotency_key: string;
  filename: string | null;
  content_hash: string;
  row_count: number;
  created_count: Generated<number>;
  existing_count: Generated<number>;
  duplicate_count: Generated<number>;
  invalid_count: Generated<number>;
  created_by: string;
  created_at: GeneratedTimestamp;
}

export interface ImportRowsTable {
  id: Generated<string>;
  tenant_id: string;
  batch_id: string;
  row_number: number;
  raw: Json;
  normalized_domain: string | null;
  outcome: ImportOutcome;
  error_code: string | null;
  error_message: string | null;
  company_id: string | null;
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

export interface CompanyAliasesTable {
  id: Generated<string>;
  tenant_id: string;
  company_id: string;
  alias: string;
  source_evidence_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface CompanyIdentifiersTable {
  id: Generated<string>;
  tenant_id: string;
  company_id: string;
  identifier_type: string;
  identifier_value: string;
  jurisdiction: string | null;
  source_evidence_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface WorkflowJobsTable {
  id: Generated<string>;
  tenant_id: string;
  company_id: string | null;
  person_id: string | null;
  job_type: JobType;
  query: ColumnType<unknown, string | null | undefined, string | null>;
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
  merged_into_id: string | null;
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

export interface PersonAliasesTable {
  id: Generated<string>;
  tenant_id: string;
  person_id: string;
  alias: string;
  created_at: GeneratedTimestamp;
}

export interface MatchCandidatesTable {
  id: Generated<string>;
  tenant_id: string;
  person_a_id: string;
  person_b_id: string;
  score: Numeric;
  rationale: string;
  status: Generated<MatchStatus>;
  created_at: GeneratedTimestamp;
  resolved_at: Timestamp | null;
  resolved_by: string | null;
}

export interface PersonMergesTable {
  id: Generated<string>;
  tenant_id: string;
  survivor_id: string;
  absorbed_id: string;
  match_candidate_id: string | null;
  actor_user_id: string;
  created_at: GeneratedTimestamp;
  undone_at: Timestamp | null;
}

export interface ContactPointsTable {
  id: Generated<string>;
  tenant_id: string;
  person_id: string;
  company_id: string | null;
  contact_type: 'work_email' | 'work_phone';
  normalized_value_hash: string;
  display_hint: string;
  value_ciphertext: Buffer;
  value_iv: Buffer;
  value_tag: Buffer;
  status: ContactStatus;
  verification_method: VerificationMethod;
  verified_at: Timestamp | null;
  claim_type: ClaimType;
  confidence: Numeric;
  source_key: string | null;
  source_evidence_id: string | null;
  workflow_job_id: string | null;
  observed_at: GeneratedTimestamp;
  created_at: GeneratedTimestamp;
}

export interface ConsentSuppressionsTable {
  id: Generated<string>;
  tenant_id: string;
  subject_type: SuppressionSubject;
  value_hash: string;
  display_hint: string;
  reason: string | null;
  created_by: string;
  created_at: GeneratedTimestamp;
}

export interface IntentSignalsTable {
  id: Generated<string>;
  tenant_id: string;
  company_id: string;
  signal_type: SignalType;
  title: string;
  summary: string;
  implies_budget: Generated<boolean>;
  claim_type: ClaimType;
  confidence: Numeric;
  country_code: string | null;
  observed_at: Timestamp;
  source_key: string;
  workflow_job_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface SignalEvidenceTable {
  signal_id: string;
  evidence_record_id: string;
  tenant_id: string;
}

export interface AiRunsTable {
  id: Generated<string>;
  tenant_id: string;
  company_id: string;
  workflow_job_id: string | null;
  provider: 'mock' | 'hermes' | 'fallback';
  prompt_version: string;
  model: string;
  status: 'succeeded' | 'quarantined' | 'failed';
  validation_outcome: 'accepted' | 'rejected' | 'fallback';
  token_count: Generated<number>;
  duration_ms: Generated<number>;
  evidence_ids: string[];
  result: Json | null;
  error_code: string | null;
  error_summary: string | null;
  created_at: GeneratedTimestamp;
}

export interface AiQuarantineTable {
  id: Generated<string>;
  tenant_id: string;
  ai_run_id: string;
  reason: string;
  raw_excerpt: string;
  errors: Json;
  created_at: GeneratedTimestamp;
}

export interface OutreachDraftsTable {
  id: Generated<string>;
  tenant_id: string;
  company_id: string;
  person_id: string;
  ai_run_id: string | null;
  body: string;
  claim_type: 'model_inference';
  confidence: Numeric;
  evidence_ids: string[];
  rationale: string;
  status: Generated<'draft' | 'approved' | 'rejected'>;
  created_at: GeneratedTimestamp;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  tenants: TenantsTable;
  memberships: MembershipsTable;
  audit_events: AuditEventsTable;
  outbox_events: OutboxEventsTable;
  icp_profiles: IcpProfilesTable;
  source_registry: SourceRegistryTable;
  tenant_source_settings: TenantSourceSettingsTable;
  discovery_candidates: DiscoveryCandidatesTable;
  import_batches: ImportBatchesTable;
  import_rows: ImportRowsTable;
  companies: CompaniesTable;
  company_aliases: CompanyAliasesTable;
  company_identifiers: CompanyIdentifiersTable;
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
  person_aliases: PersonAliasesTable;
  match_candidates: MatchCandidatesTable;
  person_merges: PersonMergesTable;
  contact_points: ContactPointsTable;
  consent_suppressions: ConsentSuppressionsTable;
  intent_signals: IntentSignalsTable;
  signal_evidence: SignalEvidenceTable;
  ai_runs: AiRunsTable;
  ai_quarantine: AiQuarantineTable;
  outreach_drafts: OutreachDraftsTable;
}
