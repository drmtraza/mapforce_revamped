import { buildOrgMapPrompt, estimateTokens } from './prompt.ts';
import type { AiProvider, ModelOutcome, OrgMapRequest } from './types.ts';

export interface HermesOptions {
  baseUrl: string;
  apiKey?: string;
}

/**
 * HTTP adapter for a hosted Hermes-compatible endpoint.
 * Globally unused unless FEATURE_HERMES and HERMES_BASE_URL are set.
 */
export class HermesAiProvider implements AiProvider {
  readonly id = 'hermes' as const;
  private readonly opts: HermesOptions;

  constructor(opts: HermesOptions) {
    this.opts = opts;
  }

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
        model: 'hermes',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
      const res = await fetch(new URL('/v1/org-map', this.opts.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt,
          max_tokens: budget.maxTokens,
          schema: 'org-map.v2',
          company_id: request.company.id,
        }),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          errorCode: 'HERMES_HTTP_ERROR',
          message: `Hermes returned HTTP ${res.status}.`,
          raw: raw.slice(0, 500),
          usage: { prompt_tokens: tokens, completion_tokens: 0 },
          model: 'hermes',
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {
          ok: false,
          errorCode: 'HERMES_INVALID_JSON',
          message: 'Hermes response was not JSON.',
          raw: raw.slice(0, 500),
          usage: { prompt_tokens: tokens, completion_tokens: 0 },
          model: 'hermes',
        };
      }
      return {
        ok: true,
        map: parsed,
        usage: { prompt_tokens: tokens, completion_tokens: estimateTokens(raw) },
        model: 'hermes',
        raw,
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        errorCode: aborted ? 'AI_TIMEOUT' : 'HERMES_UNAVAILABLE',
        message: aborted ? 'Hermes request timed out.' : 'Hermes request failed.',
        raw: '',
        usage: { prompt_tokens: tokens, completion_tokens: 0 },
        model: 'hermes',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
