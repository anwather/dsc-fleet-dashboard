/**
 * Entra (Azure AD) JWT verification.
 *
 * Validates a bearer access token issued by login.microsoftonline.com for
 * our app registration. Used to gate the dashboard routes (servers,
 * configs, assignments, jobs, run-results, audit-events) and the WebSocket.
 *
 * Agent routes (/api/agents/*) and runas (/api/runas/:urlToken) keep their
 * own bearer / URL-token auth — Entra is layered on top of human/browser
 * traffic only.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { loadEnv } from './env.js';
import { logger } from './logger.js';

export interface EntraUser {
  oid: string;            // immutable per-user object id in this tenant
  tid: string;            // tenant id (guard against cross-tenant)
  name?: string;          // display name claim
  preferredUsername?: string; // upn-ish
  scopes: string[];       // delegated scopes from the `scp` claim
}

interface EntraTokenPayload extends JWTPayload {
  oid?: string;
  tid?: string;
  name?: string;
  preferred_username?: string;
  scp?: string;           // space-delimited string of delegated scopes
  azp?: string;           // authorized party (the SPA's client id)
}

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let _issuer: string | null = null;
let _audiences: string[] = [];
let _requiredScope: string = 'access_as_user';

function init(): void {
  if (_jwks) return;
  const env = loadEnv();
  const tenant = env.ENTRA_TENANT_ID;
  _issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  // Tokens for our API may carry either `aud=<clientId>` (v2 endpoint default)
  // or `aud=api://<clientId>` (App ID URI form). Accept both.
  _audiences = [env.ENTRA_API_CLIENT_ID, `api://${env.ENTRA_API_CLIENT_ID}`];
  _requiredScope = env.ENTRA_REQUIRED_SCOPE;
  _jwks = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`),
    { cooldownDuration: 30_000, cacheMaxAge: 24 * 60 * 60 * 1000 },
  );
  logger.info(
    { issuer: _issuer, audiences: _audiences, requiredScope: _requiredScope },
    'entra auth initialised',
  );
}

/**
 * Throws on any failure (invalid signature, wrong audience, missing scope,
 * cross-tenant token, etc). Returns the verified user info on success.
 */
export async function verifyEntraJwt(token: string): Promise<EntraUser> {
  init();
  const { payload } = await jwtVerify(token, _jwks!, {
    issuer: _issuer!,
    audience: _audiences,
  });
  const p = payload as EntraTokenPayload;
  const env = loadEnv();
  if (!p.tid || p.tid !== env.ENTRA_TENANT_ID) {
    throw new Error(`token tid (${p.tid}) does not match configured tenant`);
  }
  if (!p.oid) {
    throw new Error('token missing oid claim');
  }
  // Delegated scopes live in `scp`; app-only tokens use `roles` — we don't
  // accept app-only here (dashboard is for users only).
  const scopes = typeof p.scp === 'string' && p.scp.length > 0 ? p.scp.split(' ') : [];
  if (!scopes.includes(_requiredScope)) {
    throw new Error(`token missing required scope '${_requiredScope}' (had: ${scopes.join(',') || '(none)'})`);
  }
  return {
    oid: p.oid,
    tid: p.tid,
    name: p.name,
    preferredUsername: p.preferred_username,
    scopes,
  };
}
