# Entra ID authentication

The web SPA requires interactive sign-in via Microsoft Entra ID. The API enforces the access token on all `/api/*` dashboard routes (servers, configs, assignments, jobs, run-results, audit-events) and the `/ws` WebSocket. Agent traffic (`/api/agents/*`) and `/healthz` are **not** behind Entra — agents continue to use their own per-server bearer key.

## Components

- **App registration** — single-tenant, with both *SPA* and *Expose API* platforms on the same client (one app, two surfaces).
- **API JWT validation** — `apps/api/src/lib/entraAuth.ts` uses `jose` + `createRemoteJWKSet` to validate `iss`, `aud` (accepts both `<clientId>` and `api://<clientId>`), `tid`, and requires the `scp` claim to contain `access_as_user`.
- **API enforcement** — `apps/api/src/plugins/entraAuth.ts` decorates `app.entraPreHandler`. Wired in `server.ts` as a `preHandler` hook on a child Fastify scope wrapping all dashboard routes. WebSocket auth is an `onRequest` hook on `/ws` reading `?access_token=`.
- **SPA sign-in** — MSAL React (`@azure/msal-browser` + `@azure/msal-react`). `<AuthGate>` triggers `loginRedirect` if no account. Token cache is `localStorage` for cross-tab SSO.
- **Token plumbing** — `apps/web/src/lib/authToken.ts` does silent acquisition with redirect fallback on `InteractionRequiredAuthError`. Used by both axios (`Authorization` header interceptor) and the WS hook (`?access_token=` query param).

## First-time setup

```powershell
./azure/scripts/setup-entra.ps1
```

This creates the app registration, exposes scope `api://<clientId>/access_as_user`, registers SPA redirect URIs (web URL + `http://localhost:5173`), and writes `entraTenantId` + `entraClientId` to `.azure/secrets.local.json`.

If admin consent is required for `User.Read` it will surface on first sign-in for each user (one-time prompt).

## Building and deploying

The web image **bakes** Entra IDs at build time via Vite env vars. Both build and deploy scripts auto-load the IDs from `.azure/secrets.local.json`:

```powershell
./azure/scripts/build-and-push.ps1     # both images, web gets --build-arg VITE_ENTRA_*
./azure/scripts/deploy-apps.ps1        # writes ENTRA_TENANT_ID + ENTRA_API_CLIENT_ID into api env
```

`:latest` does not auto-pull on ACA. After build, force a new revision by pinning to digest:

```powershell
$rg='dsc-fleet-dashboard'; $acr='dscfleetdscacr'
$d = az acr repository show --name $acr --image "dsc-fleet/api:<tag>" --query digest -o tsv
az containerapp update -g $rg -n api --image "$acr.azurecr.io/dsc-fleet/api@$d"
```

## Rotating credentials

The app registration holds **no client secret** (SPA + bearer-token validation is fully public-key based via JWKS). To rotate:

- **Tenant migration / new app registration**: rerun `setup-entra.ps1`, then rebuild the web image (build args are baked in) and redeploy the api (env vars only).
- **Client ID change**: update `.azure/secrets.local.json`, rebuild web, redeploy.

## Manual portal fallback

If `setup-entra.ps1` cannot run (no Graph permission, etc.):

1. Entra ID → App registrations → New registration.
   - Name: `dsc-fleet-dashboard`. Single tenant. Redirect: SPA → web URL.
2. Authentication blade → add SPA redirect `http://localhost:5173` (for dev).
3. Expose an API → set Application ID URI to `api://<clientId>` → Add scope `access_as_user` (admins + users).
4. API permissions → grant `User.Read` (Microsoft Graph) → Grant admin consent.
5. Copy Tenant ID + Client ID into `.azure/secrets.local.json`:
   ```json
   { "entraTenantId": "...", "entraClientId": "..." }
   ```

## Smoke tests

```powershell
$api='https://api.mangopond-a279fde4.australiaeast.azurecontainerapps.io'

# Anonymous → 401
curl.exe -i "$api/api/servers"
# Expect: HTTP/1.1 401 Unauthorized  /  {"error":"Unauthorized","message":"Bearer token required"}

# Bogus bearer → 401
curl.exe -i -H "Authorization: Bearer not-a-real-token" "$api/api/servers"

# Health probe → 200 (anonymous, by design)
curl.exe -i "$api/healthz"
```

Browser flow: open the web URL in incognito → expect redirect to `login.microsoftonline.com` → sign in → land on dashboard with name + Sign-out chip in top nav. WebSocket should connect on first page load (no reconnect-loop toasts).

## Troubleshooting

- **API still returns 200 anonymously after deploy** — old revision is still active. `az containerapp revision list -g dsc-fleet-dashboard -n api -o table` and deactivate any non-current revision with `az containerapp revision deactivate`.
- **Web bundle missing `VITE_ENTRA_*`** — build args weren't passed. Web throws at module load: open devtools console for the actual error. Re-run `build-and-push.ps1 -Only web`.
- **`InteractionRequiredAuthError` on every page load** — token cache lost or scopes don't match. Check `apps/web/src/lib/authConfig.ts` `apiRequest.scopes` matches what the API expects (`api://<clientId>/access_as_user`).
- **WS closes immediately with code 4401** — token expired or signed by wrong tenant. Check api logs for `verifyEntraJwt` rejection reason.
- **`charmap` UnicodeEncodeError from `az acr build`** — known Azure CLI bug on Windows cp1252; `build-and-push.ps1` polls run status and continues on the false failure.

## What is *not* protected

- `/healthz` — k8s/ACA probe target.
- `/api/agents/*` — agents authenticate with their own per-server bearer key (issued at provisioning time). Entra is never in this path.
