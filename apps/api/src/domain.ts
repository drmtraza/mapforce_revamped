import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import { AppError } from './errors.ts';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const BLOCKED_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'invalid',
];

/**
 * Normalizes user input ("https://WWW.Acme.example/path") to a registrable-looking
 * hostname ("acme.example"). Rejects IPs, single labels and internal-only names.
 */
export function normalizeDomain(input: string): string {
  let raw = input.trim().toLowerCase();
  if (raw.length === 0 || raw.length > 253) {
    throw new AppError('VALIDATION_ERROR', 'Domain is empty or too long.');
  }
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  raw = raw.split(/[/?#]/, 1)[0] ?? '';
  if (raw.includes('@'))
    throw new AppError('VALIDATION_ERROR', 'Domain must not contain credentials.');
  raw = raw.replace(/:\d+$/, '').replace(/\.$/, '');
  if (raw.startsWith('www.')) raw = raw.slice(4);

  if (isIP(raw) || raw.startsWith('[')) {
    throw new AppError(
      'VALIDATION_ERROR',
      'IP addresses are not accepted; submit a company domain.',
    );
  }
  const ascii = domainToASCII(raw);
  if (!ascii) throw new AppError('VALIDATION_ERROR', 'Domain is not a valid hostname.');
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    throw new AppError('VALIDATION_ERROR', 'Domain is not a valid hostname.');
  }
  const tld = labels[labels.length - 1] ?? '';
  if (BLOCKED_SUFFIXES.includes(tld) || /^\d+$/.test(tld)) {
    throw new AppError('VALIDATION_ERROR', 'Internal or reserved domains are not accepted.');
  }
  return ascii;
}

/** True when `host` equals `domain` or is a subdomain of it. */
export function hostWithinDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === domain || h.endsWith(`.${domain}`);
}
