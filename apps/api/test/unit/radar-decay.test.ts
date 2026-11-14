import { describe, expect, it } from 'vitest';
import {
  claimTypeLabel,
  freshnessScore,
  opportunityFingerprint,
} from '../../src/modules/radar/decay.ts';

describe('radar freshness decay', () => {
  it('decays announcements faster than product matches', () => {
    const observed = new Date('2026-10-01T00:00:00.000Z');
    const now = new Date('2026-10-15T00:00:00.000Z');
    const announcement = freshnessScore('announcement', observed, now);
    const match = freshnessScore('product_match', observed, now);
    expect(announcement).toBeLessThan(match);
    expect(announcement).toBeLessThan(50);
  });

  it('near-zero for very old announcements', () => {
    const observed = new Date('2025-01-01T00:00:00.000Z');
    const now = new Date('2026-11-15T00:00:00.000Z');
    expect(freshnessScore('announcement', observed, now)).toBeLessThan(5);
  });

  it('dedupes by company+kind+normalized title', () => {
    const a = opportunityFingerprint('co-1', 'signal', 'New SOC Hiring Wave!!!');
    const b = opportunityFingerprint('co-1', 'signal', 'new soc hiring wave');
    const c = opportunityFingerprint('co-1', 'announcement', 'new soc hiring wave');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });

  it('labels verified vs inference distinctly', () => {
    expect(claimTypeLabel('source_fact')).toBe('verified_source');
    expect(claimTypeLabel('provider_fact')).toBe('verified_source');
    expect(claimTypeLabel('model_inference')).toBe('model_inference');
  });
});
