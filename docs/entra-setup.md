# Entra ID setup

Microsoft Entra ID (formerly Azure AD) is the identity provider for the dsc-fleet
dashboard. Human/browser traffic to the SPA and to the API's dashboard routes
(`/api/servers`, `/api/configs`, `/api/assignments`, `/api/jobs`,
`/api/run-results`, `/api/audit-events`) and to the WebSocket `/ws` is gated
by an Entra-issued OAuth 2.0 bearer access token.

Agent traffic (`/api/agents/*`), the run-as credential drop endpoint
(`/api/agents/runas/:urlToken`), and the health probe (`/healthz`) are **not**
behind Entra. Agents authenticate with their own per-server bearer key issued
at provisioning time.

## Architecture at a glance

| Concern | Where it lives |
| --- | --- |
| App registration shape | Single tenant, one client; both **SPA** and **Expose API** platforms on the same app |
| API token validation | `apps/api/src/lib/entraAuth.ts` — `jose` + `createRemoteJWKSet` |
| API enforcement | `apps/api/src/plugins/entraAuth.ts` decorates `app.entraPreHandler`, wired in `server.ts` as a `preHandler` on a child Fastify scope wrapping all dashboard routes |
| WS auth | `onRequest` hook on `/ws` reading the `?access_token=` query parameter |
| SPA sign-in | `@azure/msal-browser` + `@azure/msal-react` (`apps/web/src/lib/authConfig.ts`, `AuthGate.tsx`) |
| Token plumbing | `apps/web/src/lib/authToken.ts` — silent acquisition with redirect fallback on `InteractionRequiredAuthError`; consumed by axios `Authorization` interceptor and the WS hook (`?access_token=`) |
| Agent auth (separate path) | Long-lived bearer key, hashed at rest in `agent_keys.key_hash` |

## 1. Create the app registration from scratch

The supported path is the helper script:

```powershell
./azure/scripts/setup-entra.ps1
```

It creates the app, exposes the `access_as_user` scope, registers the SPA
redirect URIs, and writes `entraTenantId` / `entraClientId` to
`.azure/secrets.local.json`.

If you can't run the script (Graph permission missing, etc.) do it manually
in the portal:

1. **Entra ID → App registrations → New registration**
   - Name: `dsc-fleet-dashboard`
   - Supported account types: **Single tenant**
   - Redirect URI: pick **SPA** and enter your web URL (e.g.
     `https://web.<env>.<region>.azurecontainerapps.io`).

2. **Authentication blade**
   - Add a second SPA redirect for local dev: `http://localhost:5173`.
   - No mobile/native or web platforms are needed.
   - Allow public client flows: **No** (SPA + PKCE is sufficient).

3. **Expose an API**
   - Set the **Application ID URI** to `api://<clientId>` (the default).
   - Add a scope `access_as_user`:
     - Who can consent: **Admins and users**
     - Admin display name: *Access dsc-fleet-dashboard as the signed-in user*
     - User display name: same
   - Pre-authorize the SPA's own client ID for `access_as_user` so
     consent doesn't need to be re-prompted.

4. **API permissions**
   - Add Microsoft Graph → **User.Read** (delegated).
   - Click **Grant admin consent for <tenant>** so users are not prompted on
     first sign-in.

5. **No client secret.** The dashboard is fully public-key based via JWKS;
   never add a secret to this app registration.

6. Copy the **Tenant ID** and **Client ID** into `.azure/secrets.local.json`:

   ```json
   {
     "entraTenantId": "00000000-0000-0000-0000-000000000000",
     "entraClientId": "00000000-0000-0000-0000-000000000000"
   }
   ```

## 2. Redirect URIs

The same app registration serves both the SPA and the API audience.

| Platform | URI | Purpose |
| --- | --- | --- |
| SPA | `https://<web-fqdn>` | Production web container |
| SPA | `http://localhost:5173` | Vite dev server |
| API (Expose API) | `api://<clientId>` | Application ID URI used by the SPA when requesting `access_as_user` |

`apps/web/src/lib/authConfig.ts` derives `redirectUri` from
`window.location.origin`, so adding new origins only requires updating the app
registration — no code change.

## 3. Scopes and token shape

The SPA requests two scope sets:

| Request | Scopes | Source |
| --- | --- | --- |
| `loginRequest` | `User.Read` | `apps/web/src/lib/authConfig.ts` — for the sign-in itself |
| `apiRequest` | `api://<clientId>/access_as_user` | `apps/web/src/lib/authConfig.ts` — used by the axios interceptor and the WS hook to acquire an API access token |

The API enforces:

| Claim | Required value |
| --- | --- |
| `iss` | `https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0` |
| `aud` | `<ENTRA_API_CLIENT_ID>` **or** `api://<ENTRA_API_CLIENT_ID>` (v2 endpoint may emit either) |
| `tid` | Must equal `ENTRA_TENANT_ID` (cross-tenant tokens are rejected) |
| `oid` | Must be present (used to correlate audit events) |
| `scp` | Space-delimited delegated scopes; must contain `access_as_user` (defaulted via `ENTRA_REQUIRED_SCOPE`) |

App-only tokens (which place permissions in `roles` rather than `scp`) are
**rejected** — the dashboard is for users only.

## 4. Group / role assignment for users

The app registration's **Enterprise application** object is what controls
*who* can sign in.

1. Entra ID → **Enterprise applications** → search for `dsc-fleet-dashboard`.
2. **Properties** → set **Assignment required?** = **Yes**. Without this any
   user in the tenant can sign in.
3. **Users and groups** → **Add user/group** → assign the security group
   (recommended) or individual users that should have dashboard access. The
   `access_as_user` scope is the only role available, which is fine — RBAC
   inside the dashboard is currently coarse (any signed-in user can do
   anything).
4. (Optional, if you want fine-grained roles later) **App registrations** →
   *(your app)* → **App roles** → define roles, then assign users to roles
   in the enterprise app. The API would need to read `roles` from the token
   to enforce them — not implemented in v1.

## 5. Federated credential setup (GitHub Actions / OIDC)

The dashboard's **runtime** doesn't need a federated credential — it validates
JWTs offline using the public JWKS. Federated credentials are only needed if
**GitHub Actions** is used to push images to ACR or run `az` commands without
storing a secret.

Add one only if you have a deploy workflow (none ships in this repo today):

1. App registration → **Certificates & secrets** → **Federated credentials** →
   **Add credential**.
2. Scenario: **GitHub Actions deploying Azure resources**.
3. Organization / Repository / Branch (or environment): scope to your repo and
   `main` (or your release branch).
4. Name: `gha-main-deploy`.
5. In the workflow, use `azure/login@v2` with `client-id`, `tenant-id`, and
   `subscription-id` (no `client-secret`). The federated assertion from the
   GHA runner is exchanged for an Azure token via the credential above.
6. Grant the app's service principal the minimum roles it needs (e.g.
   `AcrPush` on the ACR, `Container Apps Contributor` on the RG).

If you are *not* using GHA, skip this section entirely.

## 6. Token validation rules (API side)

`apps/api/src/lib/entraAuth.ts` — `verifyEntraJwt(token)` does:

```text
1. Lazily build a remote JWKS from
   https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys
   (cached 24h, with a 30s cooldown on key-set refresh).
2. jwtVerify(token, jwks, {
     issuer:  'https://login.microsoftonline.com/<tenant>/v2.0',
     audience: ['<clientId>', 'api://<clientId>'],
   })
3. Assert payload.tid === ENTRA_TENANT_ID.
4. Assert payload.oid is present.
5. Split payload.scp on space, assert it contains 'access_as_user'.
6. Return { oid, tid, name, preferredUsername, scopes }.
```

Any failure throws and the `entraPreHandler` responds `401 Unauthorized` with
a generic body — claim contents are never echoed back to the caller.

## 7. How the SPA acquires tokens (MSAL)

```text
loginRedirect (loginRequest = User.Read)
        │
        ▼
acquireTokenSilent (apiRequest = api://<clientId>/access_as_user)
        │
        ├── ok → Bearer <accessToken> on every axios request
        │       and ?access_token=<accessToken> on /ws
        │
        └── InteractionRequiredAuthError
                    │
                    ▼
            acquireTokenRedirect → user lands back on dashboard with token
```

- **Token cache**: `localStorage` so SSO survives full reloads and works
  across browser tabs. Acceptable for an internal tool; revisit if the
  dashboard becomes externally facing.
- **`<AuthGate>`** (`apps/web/src/components/auth/AuthGate.tsx`) wraps the
  app and triggers `loginRedirect` if there is no signed-in account.
- **`getApiAccessToken()`** (`apps/web/src/lib/authToken.ts`) is the single
  token-acquisition path used by both axios and the WS connector.

## 8. How the agent authenticates (NOT Entra)

Agents do **not** participate in Entra at all:

1. The dashboard issues a short-lived **provision token** when an operator
   creates a `provision` job. It travels in the Azure Run-Command script
   that bootstraps the agent.
2. The bootstrap script calls `POST /api/agents/register` with the provision
   token. The API verifies it, then returns a long-lived **agent API key**
   exactly once.
3. Every subsequent agent call (`assignments`, `revisions`, `results`,
   `heartbeat`, `removal-ack`) sends the agent key as
   `Authorization: Bearer <agent-key>`.
4. The key is stored hashed (`SHA-256`) in `agent_keys.key_hash`. Multiple
   non-revoked rows per server are allowed for zero-downtime rotation.

Agents and Entra users live in two completely separate auth pipelines that
share only the same Fastify process.

## 9. Smoke tests

```powershell
$api = 'https://api.<env>.<region>.azurecontainerapps.io'

# Anonymous → 401
curl.exe -i "$api/api/servers"
# Expect: HTTP/1.1 401 Unauthorized
# Body:   {"error":"Unauthorized","message":"Bearer token required"}

# Bogus bearer → 401
curl.exe -i -H "Authorization: Bearer not-a-real-token" "$api/api/servers"

# Health probe → 200 (anonymous, by design)
curl.exe -i "$api/healthz"
```

Browser flow: open the web URL in incognito → expect redirect to
`login.microsoftonline.com` → sign in → land on the dashboard with your name
+ Sign-out chip in the top nav. WebSocket should connect on first load (no
reconnect-loop toasts).

## 10. Rotating credentials

The app registration holds **no client secret**, so "rotation" only matters
when:

- **Tenant migration / new app registration**: rerun `setup-entra.ps1`,
  rebuild the web image (Vite env vars are baked in at build time), and
  redeploy the API (env vars only).
- **Client ID change**: update `.azure/secrets.local.json`, rebuild web,
  redeploy.

JWKS keys rotate automatically on the Microsoft side; the API picks up new
keys within the JWKS cache window (24h max, with cooldown on miss).

## 11. Troubleshooting

- **API still returns 200 anonymously after deploy** — old revision is still
  active. List revisions and deactivate old ones:
  ```powershell
  az containerapp revision list -g dsc-fleet-dashboard -n api -o table
  az containerapp revision deactivate -g dsc-fleet-dashboard -n api --revision <name>
  ```
- **Web bundle missing `VITE_ENTRA_*`** — build args weren't passed. The web
  bundle throws at module load; open devtools console for the actual error.
  Re-run `./azure/scripts/build-and-push.ps1 -Only web`.
- **`InteractionRequiredAuthError` on every page load** — token cache lost
  or scopes don't match. Verify `apiRequest.scopes` in
  `apps/web/src/lib/authConfig.ts` is exactly `api://<clientId>/access_as_user`.
- **WS closes immediately with code 4401** — token expired or signed by the
  wrong tenant. Check API logs for `verifyEntraJwt` rejection reason.
- **`charmap` UnicodeEncodeError from `az acr build`** — known Azure CLI bug
  on Windows cp1252; `build-and-push.ps1` polls run status and continues on
  the false failure.

---

## TEARDOWN

When decommissioning the app registration entirely:

1. **Revoke all user assignments**

   ```powershell
   $appId = '<entraClientId>'
   $sp = az ad sp show --id $appId | ConvertFrom-Json

   # List app-role assignments on the enterprise app
   az rest --method GET `
     --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo"

   # Delete each assignment by id
   az rest --method DELETE `
     --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo/<assignmentId>"
   ```

2. **Remove federated credentials** (only if step 5 above was used)

   ```powershell
   az ad app federated-credential list --id $appId -o table
   az ad app federated-credential delete --id $appId --federated-credential-id <name-or-id>
   ```

3. **Remove any role assignments held by the app's service principal**

   ```powershell
   az role assignment list --assignee $sp.id --all -o table
   az role assignment delete --ids <fully-qualified-roleAssignment-id>
   ```

4. **Delete the enterprise application (service principal)**

   ```powershell
   az ad sp delete --id $sp.id
   ```

5. **Delete the app registration**

   ```powershell
   az ad app delete --id $appId
   ```

   This also deletes any remaining `passwordCredentials`, `keyCredentials`,
   exposed scopes, app roles, and `oauth2PermissionGrants` (delegated
   consents) tied to the app.

6. **Clean up the dashboard side**
   - Remove `entraTenantId` / `entraClientId` from `.azure/secrets.local.json`.
   - Unset `ENTRA_TENANT_ID`, `ENTRA_API_CLIENT_ID`, `ENTRA_REQUIRED_SCOPE`
     from the API container app secrets/env. The API will refuse to start
     without them (by design — see `apps/api/src/lib/env.ts`), so the API
     should be removed at the same time as the app registration.
   - Rebuild the web image without `VITE_ENTRA_TENANT_ID` /
     `VITE_ENTRA_CLIENT_ID` build args, or take the web container down.

7. **Verify** — `az ad app show --id $appId` should return `404`, and
   `az ad sp list --filter "appId eq '$appId'"` should return `[]`.
