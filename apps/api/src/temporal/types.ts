import type { AdapterOperation, AdapterResult } from '@mapforce/contracts';

export interface SourcePlan {
  sourceKey: string;
  operation: AdapterOperation;
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

export interface AdapterRequest {
  source_key: string;
  operation: AdapterOperation;
  company: { domain: string; name: string };
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

export const DEFAULT_SOURCES: SourcePlan[] = [
  { sourceKey: 'mock_web', operation: 'fetch_company_evidence' },
  { sourceKey: 'mock_registry', operation: 'fetch_registry_record' },
  { sourceKey: 'mock_people', operation: 'discover_people' },
];
