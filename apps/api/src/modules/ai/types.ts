import type { OrgMapV2, Persona } from '@mapforce/contracts';

export interface CompactEvidence {
  id: string;
  source_key: string;
  source_url: string;
  fetched_at: string;
  excerpt: string;
}

export interface CompactPerson {
  person_id: string;
  display_name: string;
  title: string | null;
  review_status: string;
  evidence_ids: string[];
}

export interface CompactRelationship {
  subject_person_id: string;
  object_person_id: string;
  predicate: string;
  status: string;
  claim_type: string;
  rationale: string;
  evidence_ids: string[];
}

export interface CompactSignal {
  id: string;
  signal_type: string;
  title: string;
  summary: string;
  implies_budget: boolean;
  evidence_ids: string[];
}

export interface CompactIcp {
  name: string;
  industries: string[];
  countries: string[];
  target_personas: Persona[];
  signals: string[];
}

export interface OrgMapRequest {
  company: { id: string; name: string; domain: string };
  people: CompactPerson[];
  relationships: CompactRelationship[];
  signals: CompactSignal[];
  evidence: CompactEvidence[];
  icp: CompactIcp | null;
}

export interface ModelUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ModelSuccess {
  ok: true;
  map: unknown;
  usage: ModelUsage;
  model: string;
  raw: string;
}

export interface ModelFailure {
  ok: false;
  errorCode: string;
  message: string;
  raw: string;
  usage: ModelUsage;
  model: string;
}

export type ModelOutcome = ModelSuccess | ModelFailure;

export interface AiProvider {
  id: 'mock' | 'hermes';
  complete(
    request: OrgMapRequest,
    budget: { maxTokens: number; timeoutMs: number },
  ): Promise<ModelOutcome>;
}

export type DeduceResult = {
  map: OrgMapV2;
  provider: 'mock' | 'hermes' | 'fallback';
  model: string;
  validation: 'accepted' | 'rejected' | 'fallback';
  status: 'succeeded' | 'quarantined' | 'failed';
  tokenCount: number;
  durationMs: number;
  evidenceIds: string[];
  quarantine?: { reason: string; rawExcerpt: string; errors: string[] };
};
