import { createCipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

export function contactFieldKey(): string {
  const key = process.env.CONTACT_FIELD_KEY ?? '';
  if (key.length < 32) throw new Error('CONTACT_FIELD_KEY must be at least 32 characters');
  return key;
}

function keyBytes(): Buffer {
  return createHash('sha256').update(contactFieldKey()).digest();
}

export function normalizeContactValue(
  type: 'work_email' | 'work_phone' | 'email' | 'phone',
  value: string,
): string {
  const trimmed = value.trim().toLowerCase();
  if (type === 'work_email' || type === 'email') return trimmed;
  return trimmed.replace(/[^\d+]/g, '');
}

export function hashContactValue(
  type: 'work_email' | 'work_phone' | 'email' | 'phone' | 'domain' | 'person',
  value: string,
): string {
  const normalized =
    type === 'domain' || type === 'person'
      ? value.trim().toLowerCase()
      : normalizeContactValue(type, value);
  return createHash('sha256').update(normalized).digest('hex');
}

export function displayHint(
  type: 'work_email' | 'work_phone' | 'email' | 'phone' | 'domain' | 'person',
  value: string,
): string {
  if (type === 'domain') return value.trim().toLowerCase();
  if (type === 'person') return 'person';
  if (type === 'work_email' || type === 'email') {
    const [local = '', domain = ''] = value.trim().toLowerCase().split('@');
    const head = local.charAt(0) || '?';
    return `${head}***@${domain || 'unknown'}`;
  }
  const digits = value.replace(/\D/g, '');
  return `***${digits.slice(-2) || '??'}`;
}

export function encryptContactValue(plaintext: string): {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyBytes(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/** Guessed methods can never be labelled provider_verified. */
export function guessedMethod(method: string): boolean {
  return method === 'none' || method === 'pattern' || method === 'mx';
}
