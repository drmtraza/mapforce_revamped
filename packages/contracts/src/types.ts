export type SourcedClaimType = 'source_fact' | 'provider_fact';
export type ClaimType = SourcedClaimType | 'model_inference' | 'user_assertion';
export type PersonPredicate = 'REPORTS_TO' | 'INFLUENCES' | 'DECIDES_FOR' | 'WORKS_WITH';
export type Persona =
  | 'economic_buyer'
  | 'functional_champion'
  | 'technical_evaluator'
  | 'operational_user'
  | 'procurement'
  | 'unknown';

export type AdapterOperation =
  | 'fetch_company_evidence'
  | 'discover_people'
  | 'fetch_registry_record'
  | 'discover_companies'
  | 'fetch_intent_signals'
  | 'enrich_contact';

export type SignalType = 'hiring' | 'funding' | 'procurement' | 'news' | 'product' | 'other';
export type ContactType = 'work_email' | 'work_phone';
export type ContactStatus =
  | 'unverified'
  | 'provider_verified'
  | 'deliverable_likely'
  | 'invalid'
  | 'catch_all'
  | 'unknown'
  | 'suppressed';
export type VerificationMethod = 'none' | 'pattern' | 'mx' | 'provider' | 'user';

export interface AdapterCompanyCandidate {
  ref: string;
  name: string;
  domain: string;
  country_code: string | null;
  description: string | null;
  claim_type: SourcedClaimType;
  confidence: number;
  evidence_refs: string[];
}

export interface AdapterEvidence {
  ref: string;
  source_url: string;
  fetched_at: string;
  published_at: string | null;
  content_type: string;
  content_hash: string;
  excerpt: string;
  normalized_content: Record<string, unknown>;
  license_metadata: Record<string, unknown>;
}

export interface AdapterCompanyClaim {
  predicate:
    | 'canonical_name'
    | 'description'
    | 'industry'
    | 'country_code'
    | 'employee_band'
    | 'registry_identifier'
    | 'alias';
  value: string;
  claim_type: SourcedClaimType;
  confidence: number;
  evidence_refs: string[];
}

export interface AdapterPerson {
  ref: string;
  full_name: string;
  title: string | null;
  department: string | null;
  seniority: 'executive' | 'vp' | 'director' | 'manager' | 'individual_contributor' | null;
  public_profile_url: string | null;
  claim_type: SourcedClaimType;
  confidence: number;
  evidence_refs: string[];
}

export interface AdapterRelationship {
  subject_ref: string;
  predicate: PersonPredicate;
  object_ref: string;
  status: 'verified' | 'inferred';
  claim_type: SourcedClaimType | 'model_inference';
  confidence: number;
  rationale: string;
  evidence_refs: string[];
}

export interface AdapterSignal {
  ref: string;
  signal_type: SignalType;
  title: string;
  summary: string;
  implies_budget: boolean;
  claim_type: SourcedClaimType;
  confidence: number;
  country_code: string | null;
  observed_at: string;
  evidence_refs: string[];
}

export interface AdapterContactPoint {
  ref: string;
  contact_type: ContactType;
  value: string;
  status: ContactStatus;
  verification_method: VerificationMethod;
  verified_at: string | null;
  claim_type: SourcedClaimType;
  confidence: number;
  evidence_refs: string[];
}

export interface AdapterResult {
  schema_version: 1;
  source_key: string;
  provider: string;
  operation: AdapterOperation;
  status: 'succeeded' | 'failed';
  error: { code: string; message: string; retryable: boolean } | null;
  usage: { request_count: number; units: number; unit_type: string };
  evidence: AdapterEvidence[];
  company_claims: AdapterCompanyClaim[];
  companies?: AdapterCompanyCandidate[];
  people: AdapterPerson[];
  relationships: AdapterRelationship[];
  signals?: AdapterSignal[];
  contact_points?: AdapterContactPoint[];
}

export interface OrgMapPerson {
  person_id: string;
  display_name?: string | null;
  canonical_title?: string | null;
  review_status?: 'unreviewed' | 'accepted' | 'rejected' | 'disputed';
  persona: Persona;
  confidence: number;
  evidence_ids: string[];
  outreach_angle?: {
    value: string;
    claim_type: 'model_inference';
    confidence: number;
    evidence_ids: string[];
    rationale: string;
  } | null;
}

export interface OrgMapRelationship {
  relationship_id?: string;
  subject_person_id: string;
  predicate: PersonPredicate;
  object_person_id: string;
  status: 'verified' | 'inferred' | 'disputed' | 'expired';
  claim_type: ClaimType;
  confidence: number;
  evidence_ids: string[];
  rationale: string;
}

export interface OrgMapV2 {
  schema_version: 2;
  company_id: string;
  people: OrgMapPerson[];
  relationships: OrgMapRelationship[];
  unknowns: string[];
  conflicts: string[];
}

export interface EventEnvelope<P extends Record<string, unknown> = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  tenant_id: string;
  correlation_id: string;
  causation_id?: string | null;
  idempotency_key: string;
  payload: P;
}
