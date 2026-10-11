import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { hostWithinDomain, normalizeDomain } from '../../src/domain.ts';
import { decodeCursor, encodeCursor } from '../../src/http/pagination.ts';
import { evidenceKey, keyBelongsToTenant } from '../../src/modules/evidence/storage.ts';
import { backoffMs, MAX_DELIVERY_ATTEMPTS } from '../../src/modules/outbox/relay.ts';
import { confidenceBand } from '../../src/modules/people/confidence.ts';
import { normalizePersonName } from '../../src/modules/research/persist.ts';
import { can, PERMISSIONS } from '../../src/rbac.ts';
import { baseEnv } from '../support/env.ts';

describe('normalizeDomain', () => {
  it.each([
    ['https://WWW.Acme.example/about?x=1', 'acme.example'],
    ['acme.example.', 'acme.example'],
    ['sub.acme.co.uk:8443', 'sub.acme.co.uk'],
    ['bücher.example', 'xn--bcher-kva.example'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    '',
    'localhost',
    '127.0.0.1',
    '[::1]',
    'http://10.0.0.1/',
    'intranet',
    'printer.local',
    'svc.internal',
    'user:pw@acme.example',
    '-bad-.example',
    'a'.repeat(300),
  ])('rejects %s', (input) => {
    expect(() => normalizeDomain(input)).toThrow();
  });

  it('matches subdomains but not lookalikes', () => {
    expect(hostWithinDomain('careers.acme.example', 'acme.example')).toBe(true);
    expect(hostWithinDomain('acme.example', 'acme.example')).toBe(true);
    expect(hostWithinDomain('evilacme.example', 'acme.example')).toBe(false);
    expect(hostWithinDomain('acme.example.attacker.test', 'acme.example')).toBe(false);
  });
});

describe('rbac', () => {
  it('grants owners every permission', () => {
    expect(PERMISSIONS.every((p) => can('owner', p))).toBe(true);
  });
  it('keeps auditors read-only', () => {
    expect(can('auditor', 'audit.read')).toBe(true);
    expect(can('auditor', 'company.read')).toBe(true);
    for (const p of ['company.write', 'research.start', 'people.review', 'icp.write'] as const) {
      expect(can('auditor', p)).toBe(false);
    }
  });
  it('lets representatives start research but not review people or read audit', () => {
    expect(can('representative', 'research.start')).toBe(true);
    expect(can('representative', 'people.review')).toBe(false);
    expect(can('representative', 'audit.read')).toBe(false);
  });
});

describe('confidenceBand', () => {
  it.each([
    [0.9, 'strong'],
    [0.85, 'strong'],
    [0.7, 'plausible'],
    [0.5, 'weak'],
    [0.1, 'very_weak'],
  ])('%s -> %s', (value, band) => {
    const result = confidenceBand(value);
    expect(result.band).toBe(band);
    expect(result.explanation).toMatch(/not a calibrated probability/);
  });
});

describe('pagination cursor', () => {
  it('round-trips', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    const id = '7d1c8f53-4a52-4cf8-9b1e-0f7f0f7f0f7f';
    expect(decodeCursor(encodeCursor(d, id))).toEqual({ t: d.toISOString(), id });
  });
  it('rejects tampered cursors', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow();
    const sqlish = Buffer.from(JSON.stringify({ t: '2026-01-01', id: "1' OR 1=1" })).toString(
      'base64url',
    );
    expect(() => decodeCursor(sqlish)).toThrow();
  });
});

describe('evidence storage keys', () => {
  const t = '7d1c8f53-4a52-4cf8-9b1e-0f7f0f7f0f7f';
  const c = '8d1c8f53-4a52-4cf8-9b1e-0f7f0f7f0f7f';
  const e = '9d1c8f53-4a52-4cf8-9b1e-0f7f0f7f0f7f';
  it('are tenant-prefixed', () => {
    const key = evidenceKey(t, c, e);
    expect(key).toBe(`tenants/${t}/companies/${c}/evidence/${e}.json`);
    expect(keyBelongsToTenant(key, t)).toBe(true);
    expect(keyBelongsToTenant(key, c)).toBe(false);
  });
  it('refuse non-UUID components', () => {
    expect(() => evidenceKey('../x', c, e)).toThrow();
  });
});

describe('outbox backoff', () => {
  it('grows exponentially, is capped and jittered', () => {
    expect(backoffMs(1, () => 0)).toBe(1000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(50, () => 1)).toBe(300_000);
    expect(MAX_DELIVERY_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});

describe('normalizePersonName', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalizePersonName('  José   O’Neill-Smith ')).toBe('jose o neill smith');
  });
});

describe('config', () => {
  it('loads development defaults', () => {
    expect(loadConfig(baseEnv()).API_PORT).toBe(4000);
  });
  it('rejects insecure cookies in production', () => {
    expect(() => loadConfig({ ...baseEnv(), NODE_ENV: 'production' })).toThrow(/COOKIE_SECURE/);
  });
  it('rejects short session secrets', () => {
    expect(() => loadConfig({ ...baseEnv(), SESSION_COOKIE_SECRET: 'short' })).toThrow();
  });
});
