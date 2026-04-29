/**
 * Token acquisition helper.
 *
 * Tries silent acquisition first. On `InteractionRequiredAuthError` falls back
 * to a redirect — by the time we return from that redirect a token will be in
 * the cache.
 *
 * Used by both the axios interceptor and the WebSocket connector so they
 * share one path for refresh/consent edge cases.
 */
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { msalInstance } from './msal';
import { apiRequest } from './authConfig';

export async function getApiAccessToken(): Promise<string> {
  const account = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0];
  if (!account) {
    // No signed-in user — kick to login. Returning a never-resolving promise
    // is fine because the redirect navigates away.
    await msalInstance.loginRedirect(apiRequest);
    return new Promise<string>(() => {});
  }
  try {
    const result = await msalInstance.acquireTokenSilent({ ...apiRequest, account });
    return result.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      await msalInstance.acquireTokenRedirect(apiRequest);
      return new Promise<string>(() => {});
    }
    throw err;
  }
}
