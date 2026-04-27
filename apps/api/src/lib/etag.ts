import { createHash } from 'node:crypto';

/** Stable etag — sha256 hex of the canonicalised JSON. Quoted per RFC. */
export function strongEtag(value: unknown): string {
  const json = JSON.stringify(value);
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 32);
  return `"${hash}"`;
}

/** Strip surrounding quotes from a request If-None-Match / `since` value. */
export function normalizeEtag(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith('W/')) return normalizeEtag(t.slice(2));
  if (t.startsWith('"') && t.endsWith('"')) return t;
  return `"${t}"`;
}
