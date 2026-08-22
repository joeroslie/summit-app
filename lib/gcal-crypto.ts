import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'v1';
const ALGO = 'aes-256-gcm';

/** 64 hex chars = 32 bytes. Generate with: openssl rand -hex 32 */
export function getTokenEncryptionKey(): Buffer {
  const raw = (process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    throw new Error('Missing GOOGLE_TOKEN_ENCRYPTION_KEY');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'GOOGLE_TOKEN_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)'
    );
  }
  return Buffer.from(raw, 'hex');
}

export function isTokenEncryptionConfigured(): boolean {
  try {
    getTokenEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plain: string): string {
  const key = getTokenEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
}

export function decryptSecret(blob: string): string {
  const key = getTokenEncryptionKey();
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('Invalid encrypted token');
  }
  const iv = Buffer.from(parts[1]!, 'base64url');
  const tag = Buffer.from(parts[2]!, 'base64url');
  const data = Buffer.from(parts[3]!, 'base64url');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8'
  );
}
