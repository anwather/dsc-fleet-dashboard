import { randomBytes } from 'node:crypto';

/** URL-safe random token — base64url, default 32 bytes (256 bits). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
