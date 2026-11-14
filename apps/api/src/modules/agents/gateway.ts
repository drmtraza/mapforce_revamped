import { selectProvider, type AiRuntimeConfig } from '../ai/service.ts';
import type { AiProvider } from '../ai/types.ts';

/**
 * AI gateway for agentic features.
 * Live Hermes only when FEATURE_HERMES + URL; otherwise mock.
 * Account intelligence v1 uses the deterministic orchestrator and records
 * which gateway provider would be used for future model-assisted sections.
 */
export function resolveGatewayProvider(config: AiRuntimeConfig): AiProvider {
  return selectProvider(config);
}

export function gatewayProviderLabel(config: AiRuntimeConfig): 'mock' | 'hermes' {
  return config.FEATURE_HERMES && config.HERMES_BASE_URL ? 'hermes' : 'mock';
}
