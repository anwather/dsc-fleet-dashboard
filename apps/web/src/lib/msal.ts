/**
 * Singleton MSAL PublicClientApplication.
 *
 * Constructed once at module load. `initialize()` is awaited in main.tsx
 * before rendering the app; AuthGate then drives login.
 */
import { PublicClientApplication, EventType, type AccountInfo } from '@azure/msal-browser';
import { msalConfig } from './authConfig';

export const msalInstance = new PublicClientApplication(msalConfig);

// When a login completes, set the active account so silent token acquisition
// has something to work with.
msalInstance.addEventCallback((event) => {
  if (
    (event.eventType === EventType.LOGIN_SUCCESS ||
      event.eventType === EventType.ACQUIRE_TOKEN_SUCCESS) &&
    event.payload &&
    (event.payload as { account?: AccountInfo }).account
  ) {
    const account = (event.payload as { account: AccountInfo }).account;
    msalInstance.setActiveAccount(account);
  }
});
