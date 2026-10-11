import { validateOrgMapGrounding, validateOrgMapV2 } from '@mapforce/contracts';
import { fallbackOrgMap } from './fallback.ts';
import { HermesAiProvider } from './hermes.ts';
import { MockAiProvider } from './mock.ts';
import { PROMPT_VERSION } from './taxonomy.ts';
import type { AiProvider, DeduceResult, OrgMapRequest } from './types.ts';

export interface AiRuntimeConfig {
  FEATURE_HERMES: boolean;
  HERMES_BASE_URL?: string;
  HERMES_API_KEY?: string;
  AI_MAX_TOKENS: number;
  AI_TIMEOUT_MS: number;
}

export function selectProvider(config: AiRuntimeConfig): AiProvider {
  if (config.FEATURE_HERMES && config.HERMES_BASE_URL) {
    return new HermesAiProvider({
      baseUrl: config.HERMES_BASE_URL,
      apiKey: config.HERMES_API_KEY,
    });
  }
  return new MockAiProvider();
}

function allowedIds(request: OrgMapRequest) {
  return {
    companyId: request.company.id,
    personIds: request.people.map((p) => p.person_id),
    evidenceIds: request.evidence.map((e) => e.id),
  };
}

function excerpt(raw: string): string {
  return raw.slice(0, 1500);
}

/** Runs the selected provider, grounds the output, and falls back when validation fails. */
export async function deduceOrgMap(
  request: OrgMapRequest,
  provider: AiProvider,
  budget: { maxTokens: number; timeoutMs: number },
): Promise<DeduceResult> {
  const started = Date.now();
  const evidenceIds = request.evidence.map((e) => e.id);
  const outcome = await provider.complete(request, budget);
  const durationMs = Date.now() - started;
  const tokenCount = outcome.usage.prompt_tokens + outcome.usage.completion_tokens;

  if (!outcome.ok) {
    const map = fallbackOrgMap(request);
    return {
      map,
      provider: 'fallback',
      model: outcome.model,
      validation: 'fallback',
      status: 'succeeded',
      tokenCount,
      durationMs,
      evidenceIds,
      quarantine: {
        reason: outcome.errorCode,
        rawExcerpt: excerpt(outcome.raw || outcome.message),
        errors: [outcome.message],
      },
    };
  }

  const structural = validateOrgMapV2(outcome.map);
  const grounded = structural.ok
    ? validateOrgMapGrounding(structural.value, allowedIds(request))
    : structural;
  if (grounded.ok) {
    return {
      map: grounded.value,
      provider: provider.id,
      model: outcome.model,
      validation: 'accepted',
      status: 'succeeded',
      tokenCount,
      durationMs,
      evidenceIds,
    };
  }

  return {
    map: fallbackOrgMap(request),
    provider: 'fallback',
    model: outcome.model,
    validation: 'fallback',
    status: 'quarantined',
    tokenCount,
    durationMs,
    evidenceIds,
    quarantine: {
      reason: 'ORGMAP_VALIDATION_FAILED',
      rawExcerpt: excerpt(outcome.raw),
      errors: grounded.errors,
    },
  };
}

export { PROMPT_VERSION };
