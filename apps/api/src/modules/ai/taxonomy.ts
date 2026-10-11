import type { Persona } from '@mapforce/contracts';

export const PROMPT_VERSION = 'b2b_org_deducer/1.0.0';

/** Controlled title families. We never upgrade seniority beyond what the title says. */
export type RoleFamily =
  'executive' | 'vice_president' | 'director' | 'manager' | 'individual_contributor' | 'unknown';

export function canonicalizeTitle(title: string | null | undefined): string | null {
  if (!title?.trim()) return null;
  return title.trim().replace(/\s+/g, ' ');
}

export function roleFamily(title: string | null | undefined): RoleFamily {
  const t = (title ?? '').toLowerCase();
  if (!t) return 'unknown';
  if (/\b(chief|ceo|cfo|coo|ciso|cto|owner|founder|president)\b/.test(t)) return 'executive';
  if (/\b(vp|vice[ -]?president|svp)\b/.test(t)) return 'vice_president';
  if (/\b(head of|director)\b/.test(t)) return 'director';
  if (/\b(manager|lead)\b/.test(t)) return 'manager';
  return 'individual_contributor';
}

/**
 * Buying-unit persona from a title. Procurement/legal/security win over generic seniority.
 * Unknown when the title does not support a classification.
 */
export function personaFromTitle(title: string | null | undefined): Persona {
  const t = (title ?? '').toLowerCase();
  if (!t) return 'unknown';
  if (/\b(procurement|procure|purchas|legal|counsel|compliance|security|ciso)\b/.test(t)) {
    return 'procurement';
  }
  if (/\b(cto|chief technology|architect)\b/.test(t)) return 'technical_evaluator';
  if (
    /\b(vp|vice[ -]?president|head of|director)\b.*\b(engineering|engineer|information technology|\bit\b|technical)\b/.test(
      t,
    )
  ) {
    return 'technical_evaluator';
  }
  if (/\b(ceo|cfo|coo|chief|founder|owner|president)\b/.test(t)) return 'economic_buyer';
  if (/\b(vp|head of|director).*(sales|growth|revenue|marketing|product)\b/.test(t)) {
    return 'functional_champion';
  }
  if (/\b(vp|head of|director)\b/.test(t)) return 'functional_champion';
  if (/\b(manager|lead|operations|analyst)\b/.test(t)) return 'operational_user';
  if (/\b(engineer|technical)\b/.test(t)) return 'technical_evaluator';
  return 'unknown';
}

export function personaConfidence(persona: Persona, title: string | null | undefined): number {
  if (persona === 'unknown') return 0.2;
  const family = roleFamily(title);
  if (family === 'executive' || family === 'vice_president') return 0.7;
  if (family === 'director') return 0.6;
  return 0.5;
}
