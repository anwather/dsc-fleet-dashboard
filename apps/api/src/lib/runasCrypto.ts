/**
 * AES-256-GCM helpers for run-as credential encryption.
 *
 * The master key is loaded once at boot from `RUNAS_MASTER_KEY` (32-byte b64).
 * Each encrypt() generates a fresh 12-byte IV and returns iv + ciphertext +
 * auth_tag separately so the schema models them explicitly.
 *
 * GCM is AEAD: the auth_tag detects tampering of the ciphertext. We do not
 * pass any AAD; if rotation is added later, prefix the version/key-id and
 * include it as AAD.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadEnv } from './env.js';

const ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 12; // GCM standard
const TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = loadEnv();
  if (!env.RUNAS_MASTER_KEY) {
    throw new Error(
      'RUNAS_MASTER_KEY is not set; run-as credential encryption is unavailable',
    );
  }
  const buf = Buffer.from(env.RUNAS_MASTER_KEY, 'base64');
  if (buf.length !== 32) {
    throw new Error('RUNAS_MASTER_KEY must decode to exactly 32 bytes');
  }
  cachedKey = buf;
  return buf;
}

export function isCryptoAvailable(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

export interface SealedSecret {
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export function encrypt(plaintext: string): SealedSecret {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== TAG_LENGTH) {
    throw new Error(`unexpected GCM auth tag length: ${authTag.length}`);
  }
  return { iv, ciphertext, authTag };
}

export function decrypt(sealed: SealedSecret): string {
  const key = getKey();
  if (sealed.iv.length !== IV_LENGTH) {
    throw new Error('invalid IV length');
  }
  if (sealed.authTag.length !== TAG_LENGTH) {
    throw new Error('invalid auth tag length');
  }
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
  decipher.setAuthTag(sealed.authTag);
  const plaintext = Buffer.concat([
    decipher.update(sealed.ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/**
 * Generate a 32-byte URL-safe random token (43 chars).
 * Used as the per-credential URL-path component.
 */
export function generateUrlToken(): string {
  return randomBytes(32).toString('base64url');
}
