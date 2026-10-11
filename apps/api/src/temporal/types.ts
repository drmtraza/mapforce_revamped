import type { AdapterOperation, AdapterResult } from '@mapforce/contracts';

export interface SourcePlan {
  sourceKey: string;
  operation: AdapterOperation;
  /** Per-source caps; fall back to the job-level budget when absent. */
  maxEvidence?: number;
  maxRecords?: number;
}

export interface ResearchWorkflowInput {
  tenantId: string;
  jobId: string;
  companyId: string;
  domain: string;
  companyName: string;
  correlationId: string;
  pythonTaskQueue: string;
  sources: SourcePlan[];
  budget: { maxRecordsPerSource: number; maxEvidencePerSource: number };
}

export interface EnrichmentWorkflowInput {
  tenantId: string;
  jobId: string;
  companyId: string;
  personId: string;
  personName: string;
  domain: string;
  companyName: string;
  correlationId: string;
  pythonTaskQueue: string;
  sources: SourcePlan[];
  budget: { maxRecordsPerSource: number; maxEvidencePerSource: number };
}

export interface DiscoveryQuery {
  text: string;
  country_codes: string[];
}

export interface DiscoveryWorkflowInput {
  tenantId: string;
  jobId: string;
  correlationId: string;
  pythonTaskQueue: string;
  query: DiscoveryQuery;
  sources: SourcePlan[];
  budget: { maxRecordsPerSource: number; maxEvidencePerSource: number };
}

export interface AdapterRequest {
  source_key: string;
  operation: AdapterOperation;
  company?: { domain: string; name: string };
  person?: { full_name: string; title?: string | null };
  query?: DiscoveryQuery;
  budget: { max_records: number; max_evidence: number };
  correlation_id: string;
}

export interface SourceOutcome {
  sourceKey: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  errorCode?: string;
  evidenceCount?: number;
}

export interface ResearchWorkflowResult {
  status: 'succeeded' | 'partial_success' | 'failed' | 'cancelled';
  sources: SourceOutcome[];
}

/**
 * What the Python worker returns. `result` is untrusted until the control plane
 * validates it against adapter-result.v1.schema.json.
 */
export interface AdapterInvocation {
  attempt: number;
  result: AdapterResult | Record<string, unknown>;
}

/** Activities implemented by the Python research worker. */
export interface PythonActivities {
  run_adapter(request: AdapterRequest): Promise<AdapterInvocation>;
}

export const RESEARCH_OPERATIONS: readonly AdapterOperation[] = [
  'fetch_company_evidence',
  'fetch_registry_record',
  'discover_people',
  'fetch_intent_signals',
];
export const DISCOVERY_OPERATIONS: readonly AdapterOperation[] = ['discover_companies'];
export const ENRICH_OPERATIONS: readonly AdapterOperation[] = ['enrich_contact'];
