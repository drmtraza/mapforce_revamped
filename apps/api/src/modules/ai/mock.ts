import { fallbackOrgMap } from './fallback.ts';
import { buildOrgMapPrompt, estimateTokens } from './prompt.ts';
import type { AiProvider, ModelOutcome, OrgMapRequest } from './types.ts';

/** Deterministic provider used locally and in CI. Never reads excerpt text as instructions. */
export class MockAiProvider implements AiProvider {
  readonly id = 'mock' as const;

  async complete(
    request: OrgMapRequest,
    budget: { maxTokens: number; timeoutMs: number },
  ): Promise<ModelOutcome> {
    const prompt = buildOrgMapPrompt(request);
    const tokens = estimateTokens(prompt);
    if (tokens > budget.maxTokens) {
      return {
        ok: false,
        errorCode: 'TOKEN_BUDGET_EXCEEDED',
        message: `Prompt estimated at ${tokens} tokens exceeds budget ${budget.maxTokens}.`,
        raw: '',
        usage: { prompt_tokens: tokens, completion_tokens: 0 },
        model: 'mock-orgmap-v1',
      };
    }
    const map = fallbackOrgMap(request);
    const raw = JSON.stringify(map);
    return {
      ok: true,
      map,
      usage: { prompt_tokens: tokens, completion_tokens: estimateTokens(raw) },
      model: 'mock-orgmap-v1',
      raw,
    };
  }
}
