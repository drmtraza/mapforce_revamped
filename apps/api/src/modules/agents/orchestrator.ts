/**
 * Account intelligence orchestrator (account-intel/1.0.0).
 * Deterministic specialist agents + optional model gateway later.
 * Never invents emails, reporting lines, or buying intent.
 */

export const ORCHESTRATOR_VERSION = 'account-intel/1.0.0';

export type ClaimType = 'source_fact' | 'provider_fact' | 'model_inference' | 'user_assertion';

export interface AgentClaim {
  key: string;
  text: string;
  claim_type: ClaimType;
  evidence_ids: string[];
  agent: 'research' | 'signals' | 'matching' | 'evidence_check';
}

export interface AgentSection {
  id: string;
  title: string;
  claims: AgentClaim[];
}

export interface AgentTraceStep {
  agent: string;
  ok: boolean;
  detail: string;
  duration_ms: number;
}

export interface OrchestratorInput {
  company: {
    id: string;
    name: string | null;
    domain: string;
    industry: string | null;
    country_code: string | null;
    description: string | null;
  };
  evidence: { id: string; source_key: string; excerpt: string }[];
  people: { id: string; display_name: string; title: string | null; evidence_ids: string[] }[];
  signals: {
    id: string;
    signal_type: string;
    title: string;
    summary: string;
    claim_type: ClaimType;
    evidence_ids: string[];
  }[];
  matches: {
    offering_name: string;
    match_score: number;
    note: string;
    eligible: boolean;
  }[];
}

export interface OrchestratorResult {
  summary: string;
  sections: AgentSection[];
  quarantined_claims: AgentClaim[];
  agent_trace: AgentTraceStep[];
  status: 'draft_for_review' | 'quarantined';
  provider: 'deterministic';
}

function timed<T>(agent: string, fn: () => T): { value: T; step: AgentTraceStep } {
  const started = Date.now();
  try {
    const value = fn();
    return {
      value,
      step: {
        agent,
        ok: true,
        detail: 'completed',
        duration_ms: Date.now() - started,
      },
    };
  } catch (err) {
    return {
      value: [] as T,
      step: {
        agent,
        ok: false,
        detail: err instanceof Error ? err.message : 'failed',
        duration_ms: Date.now() - started,
      },
    };
  }
}

function researchAgent(input: OrchestratorInput): AgentClaim[] {
  const claims: AgentClaim[] = [];
  const evidenceIds = input.evidence.map((e) => e.id);
  claims.push({
    key: 'company_identity',
    text: `${input.company.name ?? input.company.domain} (${input.company.domain})`,
    claim_type: evidenceIds.length ? 'source_fact' : 'user_assertion',
    evidence_ids: evidenceIds.slice(0, 5),
    agent: 'research',
  });
  if (input.company.industry) {
    claims.push({
      key: 'industry',
      text: `Industry recorded as ${input.company.industry}`,
      claim_type: evidenceIds.length ? 'provider_fact' : 'user_assertion',
      evidence_ids: evidenceIds.slice(0, 3),
      agent: 'research',
    });
  }
  if (input.company.country_code) {
    claims.push({
      key: 'geography',
      text: `Country code ${input.company.country_code}`,
      claim_type: 'user_assertion',
      evidence_ids: [],
      agent: 'research',
    });
  }
  for (const p of input.people.slice(0, 8)) {
    claims.push({
      key: `person:${p.id}`,
      text: `${p.display_name}${p.title ? ` — ${p.title}` : ''}`,
      claim_type: p.evidence_ids.length ? 'source_fact' : 'model_inference',
      evidence_ids: p.evidence_ids.slice(0, 5),
      agent: 'research',
    });
  }
  return claims;
}

function signalsAgent(input: OrchestratorInput): AgentClaim[] {
  return input.signals.slice(0, 12).map((s) => ({
    key: `signal:${s.id}`,
    text: `[${s.signal_type}] ${s.title}: ${s.summary}`,
    claim_type: s.claim_type,
    evidence_ids: s.evidence_ids.slice(0, 5),
    agent: 'signals' as const,
  }));
}

function matchingAgent(input: OrchestratorInput): AgentClaim[] {
  return input.matches
    .filter((m) => m.eligible && m.match_score >= 40)
    .slice(0, 8)
    .map((m, i) => ({
      key: `match:${i}:${m.offering_name}`,
      text: `Catalogue fit ${m.match_score}/100 for ${m.offering_name}. ${m.note}`,
      claim_type: 'model_inference' as const,
      evidence_ids: [],
      agent: 'matching' as const,
    }));
}

function evidenceCheckAgent(claims: AgentClaim[]): {
  kept: AgentClaim[];
  quarantined: AgentClaim[];
} {
  const kept: AgentClaim[] = [];
  const quarantined: AgentClaim[] = [];
  for (const c of claims) {
    const needsEvidence = c.claim_type === 'source_fact' || c.claim_type === 'provider_fact';
    if (needsEvidence && c.evidence_ids.length === 0) {
      quarantined.push({
        ...c,
        text: `[quarantined] ${c.text} — missing evidence for ${c.claim_type}`,
      });
      continue;
    }
    kept.push(c);
  }
  return { kept, quarantined };
}

export function runAccountIntelligence(input: OrchestratorInput): OrchestratorResult {
  const trace: AgentTraceStep[] = [];
  const research = timed('research', () => researchAgent(input));
  trace.push(research.step);
  const signals = timed('signals', () => signalsAgent(input));
  trace.push(signals.step);
  const matching = timed('matching', () => matchingAgent(input));
  trace.push(matching.step);

  const merged = [...research.value, ...signals.value, ...matching.value];
  const checked = timed('evidence_check', () => evidenceCheckAgent(merged));
  trace.push({
    ...checked.step,
    detail: `kept=${checked.value.kept.length} quarantined=${checked.value.quarantined.length}`,
  });

  const sections: AgentSection[] = [
    {
      id: 'research',
      title: 'Account research',
      claims: checked.value.kept.filter((c) => c.agent === 'research'),
    },
    {
      id: 'signals',
      title: 'Signals',
      claims: checked.value.kept.filter((c) => c.agent === 'signals'),
    },
    {
      id: 'matching',
      title: 'Product fit (not ICP score)',
      claims: checked.value.kept.filter((c) => c.agent === 'matching'),
    },
  ];

  const summaryParts = [
    `Account intelligence for ${input.company.name ?? input.company.domain}.`,
    `${checked.value.kept.length} grounded claims across research, signals, and catalogue fit.`,
    checked.value.quarantined.length
      ? `${checked.value.quarantined.length} claims quarantined for missing evidence.`
      : 'No claims quarantined.',
    'Draft for human review — not written to CRM. Not buying intent.',
  ];

  return {
    summary: summaryParts.join(' '),
    sections,
    quarantined_claims: checked.value.quarantined,
    agent_trace: trace,
    status:
      checked.value.quarantined.length > merged.length / 2 ? 'quarantined' : 'draft_for_review',
    provider: 'deterministic',
  };
}
