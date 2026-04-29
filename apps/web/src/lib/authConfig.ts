/**
 * Auth configuration for MSAL.
 *
 * Tenant + client id are baked at Vite build time via env vars. Both must
 * be set or the app refuses to load (we'd rather hard-fail than silently
 * ship an unauthenticated dashboard).
 */
import type { Configuration } from '@azure/msal-browser';

const tenantId = import.meta.env.VITE_ENTRA_TENANT_ID;
const clientId = import.meta.env.VITE_ENTRA_CLIENT_ID;

if (!tenantId || !clientId) {
  // Surface a loud, obvious failure during dev/CI rather than a confusing
  // MSAL error. Production builds also crash here if the build args weren't
  // passed.
  throw new Error(
    'VITE_ENTRA_TENANT_ID and VITE_ENTRA_CLIENT_ID must be set at build time',
  );
}

export const ENTRA_TENANT_ID = tenantId;
export const ENTRA_CLIENT_ID = clientId;

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    // localStorage gives us SSO across tabs and survives full reloads. It is
    // XSS-readable; acceptable for this internal tool. Revisit if the app
    // ever becomes externally facing.
    cacheLocation: 'localStorage',
  },
};

/** Scopes requested at login (Microsoft Graph + our API). */
export const loginRequest = {
  scopes: ['User.Read'],
};

/** Scopes requested when calling our API. */
export const apiRequest = {
  scopes: [`api://${clientId}/access_as_user`],
};
