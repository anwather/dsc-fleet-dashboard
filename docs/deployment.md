# dsc-fleet-dashboard — Deployment & Teardown Runbook

End-to-end runbook for deploying the dsc-fleet-dashboard solution from a clean
subscription, and for tearing it down again. Solution spans two repos:

| Repo | Role |
|---|---|
| `dsc-fleet-dashboard` (this repo) | TypeScript / React SPA + Fastify API on Azure Container Apps, Entra-gated, managed Postgres, runs in RG `dsc-fleet-dashboard`. |
| `dsc-fleet` (peer repo at `C:\Source\dsc-fleet`) | PowerShell agent + `DscV3.RegFile` custom DSC v3 module. Installed onto Windows Server lab VMs (RG `dsc-v3`). |

Defaults assumed throughout (override per environment):

| Setting | Value |
|---|---|
| Subscription | `01e2f327-74ac-451e-8ad9-1f923a06d634` |
| Region | `australiaeast` |
| Dashboard RG | `dsc-fleet-dashboard` |
| Lab RG (managed VMs) | `dsc-v3` |
| Name suffix | `dsc` |

Resources whose names depend on `nameSuffix=dsc`:

- ACR: `dscfleetdscacr` (login server `dscfleetdscacr.azurecr.io`)
- Storage account: `dscfleetdscsa`
- UAMI: `id-dsc-fleet-dashboard`
- ACA env: `cae-dsc-fleet-dashboard`
- Log Analytics: `log-dsc-fleet-dashboard`
- Postgres flex server: `dsc-fleet-dashboard-pg`

---

## Prerequisites

Install on the workstation running the deploy:

```powershell
# Azure CLI 2.61+ (bicep auto-installed on first use)
winget install -e --id Microsoft.AzureCLI

# PowerShell 7.4+
winget install -e --id Microsoft.PowerShell

# Node.js 20 LTS (for any local dev / migrations)
winget install -e --id OpenJS.NodeJS.LTS

# Docker Desktop is OPTIONAL — image builds are server-side via `az acr build`
winget install -e --id Docker.DockerDesktop
```

Required identities and rights:

- `az login` user with **Owner on the subscription** (needed for `az deployment sub create` + role assignments on the lab RG).
- **Application Administrator** (or Cloud Application Administrator) for Entra app registration. If not held, the script falls back to manual portal steps printed by `azure/scripts/setup-entra.ps1`.

```powershell
az login
az account set --subscription 01e2f327-74ac-451e-8ad9-1f923a06d634
az account show --query '{name:name,id:id,tenantId:tenantId}'
```

### Repos to fork & clone

The solution spans **two** repos. Both are templates — fork into your own
GitHub org so you can pin tags, push your own configs, and keep secrets
out of upstream issues. The two repos are tightly coupled at deploy
time and you'll typically fork them together:

| Upstream | Fork to | Used by |
|---|---|---|
| `https://github.com/anwather/dsc-fleet-dashboard` | `https://github.com/<your-org>/dsc-fleet-dashboard` | Your workstation (this runbook) |
| `https://github.com/anwather/dsc-fleet`           | `https://github.com/<your-org>/dsc-fleet`           | Each lab VM (downloaded by `Install-DscV3.ps1` in Phase 6) |

```powershell
# After forking on github.com:
$org = '<your-github-org>'   # e.g. 'anwather'
git clone "https://github.com/$org/dsc-fleet-dashboard.git" C:\Source\dsc-fleet-dashboard
git clone "https://github.com/$org/dsc-fleet.git"           C:\Source\dsc-fleet

cd C:\Source\dsc-fleet-dashboard
npm install   # only needed for local dev / migrations from your workstation
```

If you fork `dsc-fleet` to a non-default org, override the bootstrap
default in Phase 6:

```powershell
& "$repo\bootstrap\Install-DscV3.ps1" `
    -PlatformRepoUrl "https://github.com/$org/dsc-fleet.git" `
    -PlatformRef     main
```

> ℹ️ The historical third repo `anwather/dsc-fleet-configs` is
> **archived** and no longer required. Sample configurations now ship
> embedded in the web bundle at `apps/web/src/lib/samples.ts`; the
> agent runs only in `-Mode Dashboard` and no longer pulls YAML from
> a Git repo.

### Secrets file: `.azure/secrets.local.json`

A handful of scripts in `azure/scripts/` create and read a single
gitignored file at `.azure/secrets.local.json` (the `.azure/` folder
is auto-added to `.gitignore` by `deploy-apps.ps1` on first run).
Schema, with which script writes each key:

| Key               | Written by             | Used by                                            |
|-------------------|------------------------|----------------------------------------------------|
| `entraTenantId`   | `setup-entra.ps1`      | `build-and-push.ps1` (web build arg), `deploy-apps.ps1` (API env var) |
| `entraClientId`   | `setup-entra.ps1`      | `build-and-push.ps1`, `deploy-apps.ps1`, T6 teardown |
| `pgPassword`      | `deploy-apps.ps1`      | `deploy-apps.ps1` (Postgres admin password), Phase 5 manual psql |
| `runAsMasterKey`  | `deploy-apps.ps1`      | `deploy-apps.ps1` (API `RUNAS_MASTER_KEY` env var) |

Both `pgPassword` and `runAsMasterKey` are auto-generated on first
deploy — you don't supply them. `runAsMasterKey` can be rotated with
`deploy-apps.ps1 -RotateRunAsKey` (which **invalidates** any encrypted
run-as credentials already in the database — see "Post-redeploy:
re-register reused agents" below).

> ⚠️ If you lose `secrets.local.json` after deploy you can recover
> `entraTenantId` / `entraClientId` from the app reg, but `pgPassword`
> and `runAsMasterKey` are only stored here and as Container App
> secrets. Inspect the live secrets if needed:
> ```powershell
> az containerapp secret list -g dsc-fleet-dashboard -n api -o table
> az containerapp secret show -g dsc-fleet-dashboard -n api `
>     --secret-name runas-master-key --query value -o tsv
> ```

---

## Mandatory phase order

The Entra app registration's SPA redirect URI depends on the ACA environment's
`defaultDomain`, which only exists once the infra is deployed. To avoid a
"chicken-and-egg" failure on a clean redeploy, Phase 1 is **split** and
interleaved with Phase 2:

1. **Phase 1a** — plan the app registration (name + tenant). No action yet.
2. **Phase 2** — deploy Bicep infra (`deployApps=false`). Capture
   `containerAppsEnvironmentDefaultDomain` from the outputs.
3. **Phase 1b** — run `setup-entra.ps1 -WebUrl https://web.<defaultDomain>`
   to create the app registration with the correct SPA redirect URI.
4. **Phase 3** — build & push the web image (it bakes in
   `VITE_ENTRA_TENANT_ID` / `VITE_ENTRA_CLIENT_ID` from 1b).
5. **Phase 4** — deploy the Container Apps (`deployApps=true`).
6. **Phases 5–8** — DB init, agent provisioning, lab module deploy, smoke test.

This matches the quickstart sequence in [`../azure/README.md`](../azure/README.md#quickstart-deploy).

---

## Phase 1a — Plan the Entra app registration

The web SPA + API share **one** app registration with two platforms (SPA + Expose API). See `azure/ENTRA-AUTH.md` for the full design notes.

There is **nothing to run in Phase 1a** — the actual `setup-entra.ps1` invocation
is deferred to Phase 1b (after Phase 2), because its `-WebUrl` argument depends
on the ACA environment `defaultDomain` produced by the Phase 2 Bicep deploy.

In Phase 1a, just decide:

- **Display name** for the app registration (default: `DSC Fleet Dashboard`).
- **Tenant** — must match the subscription you're deploying into; cross-tenant
  is not supported by `entraAuth.ts`.
- Whether you have **Application Administrator** (or Cloud Application
  Administrator) — if not, the script will print manual portal fallback steps.

> ⚠️ The web Vite bundle **bakes in** `VITE_ENTRA_TENANT_ID` and `VITE_ENTRA_CLIENT_ID` at build time. Any change to these (including running Phase 1b for the first time) requires rebuilding the web image (Phase 3) before Phase 4.

---

## Phase 2 — Bicep infrastructure deploy

Subscription-scope template at `azure/bicep/main.bicep` creates everything **except** the three Container Apps (those land in Phase 4).

Deployed resources (RG `dsc-fleet-dashboard`):

- Resource group itself
- Log Analytics workspace `log-dsc-fleet-dashboard` (PerGB2018, 7-day retention, 1 GiB cap)
- Azure Container Registry `dscfleetdscacr` (Basic SKU, admin disabled)
- User-assigned managed identity `id-dsc-fleet-dashboard`
  - **AcrPull** on the ACR (same RG)
  - **Virtual Machine Contributor** on the lab RG `dsc-v3` (cross-RG, for `Invoke-AzVMRunCommand` from the API)
- Storage account `dscfleetdscsa` + SMB share `pgdata` (100 GiB, SMB 3.1.1, AES-256-GCM)
- ACA managed environment `cae-dsc-fleet-dashboard` (workload-profiles, Consumption) with `pgdata` linked as managed env storage

### 2.1 Deploy

```powershell
cd C:\Source\dsc-fleet-dashboard
./azure/scripts/deploy.ps1                       # interactive (what-if + prompt)
# alternatives:
./azure/scripts/deploy.ps1 -WhatIfOnly            # show changes only
./azure/scripts/deploy.ps1 -SkipWhatIf            # CI / non-interactive
./azure/scripts/deploy.ps1 -SkipLabRbac           # skip cross-RG role assignment if you lack Owner on dsc-v3
```

Equivalent raw command (what the script runs):

```azurecli
az deployment sub create `
  --name phase1-$(Get-Date -Format yyyyMMdd-HHmmss) `
  --location australiaeast `
  --template-file azure/bicep/main.bicep `
  --parameters location=australiaeast rgName=dsc-fleet-dashboard `
              labRgName=dsc-v3 nameSuffix=dsc assignVmContributor=true
```

On success the script prints all outputs — capture `containerAppsEnvironmentDefaultDomain` for Phase 1b / 4.

---

## Phase 1b — Create the Entra app registration

Now that Phase 2 has produced a stable ACA env `defaultDomain`, register the
SPA redirect URI against the real web FQDN. Substitute the
`containerAppsEnvironmentDefaultDomain` output captured above:

```powershell
./azure/scripts/setup-entra.ps1 `
    -DisplayName 'DSC Fleet Dashboard' `
    -WebUrl      "https://web.<containerAppsEnvironmentDefaultDomain>"
```

This will:

1. Create (or reuse) an app reg called `DSC Fleet Dashboard`, single tenant.
2. Add **SPA** redirect URIs: the prod web URL + `http://localhost:5173` for dev. **No client secret. No implicit grant — PKCE only.**
3. Set `Application ID URI = api://<clientId>` and expose scope `access_as_user` (admins + users can consent).
4. Add Microsoft Graph `User.Read` delegated permission and attempt admin consent (silently skipped if you lack the role — users will consent on first sign-in).
5. Persist `entraTenantId` + `entraClientId` to `.azure/secrets.local.json` (gitignored).

### 1b.1 Manual portal fallback

If the script prints “Cannot create the app registration via az CLI”, follow its printed steps. The minimum required state is documented at `azure/ENTRA-AUTH.md` § *Manual portal fallback*. After creating manually, write to `.azure/secrets.local.json`:

```json
{ "entraTenantId": "<tenant-guid>", "entraClientId": "<app-guid>" }
```

### 1b.2 If the web URL later changes (re-deploy / new env)

The web FQDN is derived from the ACA env's `defaultDomain`. If you re-create
the env (e.g. after a teardown), the `defaultDomain` will change and the
existing redirect URI will stop matching. Re-run:

```powershell
./azure/scripts/setup-entra.ps1 -WebUrl "https://web.<newDefaultDomain>"
```

then rebuild the web image (Phase 3) and roll out (Phase 4) so the SPA bundle
points at the new domain.

---

## Phase 3 — Build & push images

Both images are built **server-side** by `az acr build` (no local Docker required). Build context is the repo root; Dockerfiles are at `apps/api/Dockerfile` and `apps/web/Dockerfile`.

```powershell
# Both images, tag = git short SHA (and :latest)
./azure/scripts/build-and-push.ps1

# Or pin a tag
./azure/scripts/build-and-push.ps1 -Tag v1

# One image at a time
./azure/scripts/build-and-push.ps1 -Only api -Tag v1
./azure/scripts/build-and-push.ps1 -Only web -Tag v1
```

What the script does:

- Forces UTF-8 (`PYTHONIOENCODING=utf-8`) to dodge the cp1252 crash from the Prisma `✔` glyph.
- Reads `entraTenantId` + `entraClientId` from `.azure/secrets.local.json` and passes them to the **web** build as `--build-arg VITE_ENTRA_TENANT_ID=...` / `VITE_ENTRA_CLIENT_ID=...` (baked into the SPA).
- Pushes each image with two tags: the explicit tag and `:latest`.
- If the streaming `az acr build` exits non-zero (false failure on Windows), the script polls `az acr task list-runs` and continues if the run actually `Succeeded`.

Repository naming:

- `dscfleetdscacr.azurecr.io/dsc-fleet/api:<tag>`
- `dscfleetdscacr.azurecr.io/dsc-fleet/web:<tag>`

---

## Phase 4 — Container Apps rollout

`apps/api`, `apps/web`, and (optionally) `postgres` are deployed by re-invoking `main.bicep` with `deployApps=true`. The wrapper script handles secret generation and the Postgres flex-server provisioning.

### 4.1 Deploy

```powershell
./azure/scripts/deploy-apps.ps1                 # what-if + interactive deploy
./azure/scripts/deploy-apps.ps1 -Tag <sha>      # pin a specific image tag
./azure/scripts/deploy-apps.ps1 -SkipWhatIf     # CI re-deploy
./azure/scripts/deploy-apps.ps1 -RotateRunAsKey # NEW key — INVALIDATES existing run-as creds
```

What gets created (`postgresMode=managed`, the default):

- **Postgres Flexible Server** `dsc-fleet-dashboard-pg`
  - SKU `Standard_B1ms` (Burstable), Postgres 16, 32 GiB storage (autogrow), 7-day backup.
  - Public network access **enabled** with `AllowAllAzureServices` firewall rule (start `0.0.0.0`, end `0.0.0.0` — the special "any Azure" rule).
  - Admin user `dscadmin`, password from `.azure/secrets.local.json`.
  - Initial database `dscfleet`.
- **`api` Container App** — external HTTPS ingress on `:3000`, single replica (in-process scheduler — DO NOT scale up), pulls from ACR via UAMI, runs `prisma migrate deploy` then `node dist/server.js` on startup.
- **`web` Container App** — external HTTPS on `:80`, nginx serving the SPA + reverse-proxying `/api/*` to `api`.
- **`postgres` Container App** — only created when `postgresMode=container` (not the default; see `apps.bicep` — chmod on the SMB volume is a known issue).

### 4.2 Env vars on the API container

Set via `apps.bicep` → `apps/api`. Source of truth for required vars: `apps/api/src/lib/env.ts`.

| Var | Source |
|---|---|
| `NODE_ENV` | literal `production` |
| `API_PORT` | `3000` |
| `LOG_LEVEL` | `info` |
| `DATABASE_URL` | secret `database-url` (built from `pgUser/pgPassword/pgHost/pgDatabase` + `sslmode=require`) |
| `RUNAS_MASTER_KEY` | secret `runas-master-key` (32-byte base64) |
| `PUBLIC_BASE_URL` | `https://web.<envDefaultDomain>` |
| `AGENT_POLL_DEFAULT_SECONDS` | `60` |
| `AZURE_SUBSCRIPTION_ID` | subscription where lab VMs live |
| `AZURE_CLIENT_ID` | UAMI client id (for `DefaultAzureCredential`) |
| `ENTRA_TENANT_ID` | from `.azure/secrets.local.json` |
| `ENTRA_API_CLIENT_ID` | from `.azure/secrets.local.json` |

### 4.3 Force a revision after a re-push to `:latest`

ACA does not auto-pull on tag changes. Pin to digest:

```powershell
$rg='dsc-fleet-dashboard'; $acr='dscfleetdscacr'
$d  = az acr repository show --name $acr --image "dsc-fleet/api:latest" --query digest -o tsv
az containerapp update -g $rg -n api --image "$acr.azurecr.io/dsc-fleet/api@$d"

$d  = az acr repository show --name $acr --image "dsc-fleet/web:latest" --query digest -o tsv
az containerapp update -g $rg -n web --image "$acr.azurecr.io/dsc-fleet/web@$d"
```

Verify:

```powershell
az containerapp revision list -g dsc-fleet-dashboard -n api -o table
az containerapp revision list -g dsc-fleet-dashboard -n web -o table
```

---

## Phase 5 — Database init

The API container runs `npx prisma migrate deploy` on every startup (see the `CMD` in `apps/api/Dockerfile`). **Migrations run automatically on API container startup** — there is no separate "init" step to perform before Phase 4. The flex server only exists once `deployApps=true`, which is the same Bicep invocation that deploys the API container, so there is no window in which the database exists without an API to migrate it.

Watch the api logs to confirm migrations applied cleanly:

```powershell
az containerapp logs show -g dsc-fleet-dashboard -n api --tail 100 --follow
```

Expect lines like `Applying migration 'YYYYMMDDHHMMSS_<name>'` followed by `All migrations have been successfully applied.` then the Fastify boot banner.

### If a migration fails

If a migration fails the API will **crash-loop** (the Dockerfile `CMD` chains `prisma migrate deploy` before `node dist/server.js`, so an exit code from Prisma takes the container down). To recover:

1. Tail the api container logs (above) to see the failing SQL / Prisma error.
2. Fix the offending migration in `apps/api/prisma/migrations/`.
3. Build and push a new api image (Phase 3) with a fresh tag.
4. Roll forward:
   ```powershell
   az containerapp update -g dsc-fleet-dashboard -n api `
       --image dscfleetdscacr.azurecr.io/dsc-fleet/api:<new-tag>
   ```

Do **not** try to "fix forward" by running `prisma migrate deploy` from your workstation against the live database — Prisma's migration table is the source of truth and a manual run from a different working tree will desync it from the api image.

### Manual psql / schema inspection from your workstation (debug only)

Sometimes you need direct DB access for debugging (e.g. `psql`, `prisma studio`, ad-hoc `SELECT`s). This is a debug path, not part of normal deploy:

```powershell
$pg = az postgres flexible-server show -g dsc-fleet-dashboard -n dsc-fleet-dashboard-pg --query fullyQualifiedDomainName -o tsv
$pw = (Get-Content .azure/secrets.local.json | ConvertFrom-Json).pgPassword
$env:DATABASE_URL = "postgresql://dscadmin:$pw@$pg:5432/dscfleet?schema=public&sslmode=require"

# Allow your workstation's egress IP through the flex-server firewall first:
$ip = (Invoke-RestMethod https://api.ipify.org)
az postgres flexible-server firewall-rule create -g dsc-fleet-dashboard -n dsc-fleet-dashboard-pg `
    --rule-name dev-laptop --start-ip-address $ip --end-ip-address $ip

cd apps/api
npx prisma studio        # or: psql, etc.
```

**Clean up the firewall rule when done** — `dev-laptop` leaves the flex server open to whichever IP your workstation happened to have, which is almost certainly someone else's IP tomorrow:

```powershell
az postgres flexible-server firewall-rule delete -g dsc-fleet-dashboard `
    -n dsc-fleet-dashboard-pg --rule-name dev-laptop --yes
```

Any other ad-hoc rules (`tmp-debug`, etc.) should also be deleted at the end of a debug session — only `AllowAllAzureServices` should survive between sessions. See T8 for the full firewall-rule cleanup snippet.

---

## Phase 6 — Agent provisioning (Windows Server lab VM)

Each managed Windows Server VM in RG `dsc-v3` runs a SYSTEM-context scheduled task `DscV3-Apply` that polls the dashboard every 60s.

### 6.1 Provision the VM

Create or reuse a Windows Server 2019/2022/2025 VM in `dsc-v3`:

```azurecli
az vm create -g dsc-v3 -n dsc-03 --image Win2022Datacenter --size Standard_B2s `
    --admin-username labadmin --admin-password '<strong-password>' `
    --public-ip-sku Standard --nsg-rule RDP
```

### 6.2 Add the server in the dashboard UI

1. Sign in to the dashboard (Phase 8).
2. **Servers → Add server** → enter Azure resource id of the VM, choose run-as identity (SYSTEM / domain account / gMSA).
3. The dashboard issues a **single-use provision token** and (for password run-as) a **single-use credential URL**.

### 6.3 Run the bootstrap on the VM

Two scripts from `dsc-fleet/bootstrap/`. Easiest path: have the dashboard launch them via Azure VM Run Command (the API does this when you click *Provision*). Manual equivalent:

```powershell
# On the target VM, in an elevated PowerShell 5.1+ session
$repo  = 'C:\Source\dsc-fleet'
git clone https://github.com/anwather/dsc-fleet.git $repo

# 1) Idempotent prereqs + module + runner install
& "$repo\bootstrap\Install-DscV3.ps1" -PlatformRef main

# 2) Register with the dashboard (token + credentialUrl from the UI)
& "$repo\bootstrap\Register-DashboardAgent.ps1" `
    -DashboardUrl   'https://api.mangopond-XXXXXXXX.australiaeast.azurecontainerapps.io' `
    -ProvisionToken '<single-use-provision-token>' `
    -CredentialUrl  '<single-use-credential-url>'   # omit for SYSTEM run-as
```

What `Install-DscV3.ps1` does:

- Calls `Install-Prerequisites.ps1` → installs **PowerShell 7 LTS**, **DSC v3 CLI** (pinned `3.1.3`), **Visual C++ 2015-2022 Redistributable**, **Git for Windows**, **PSResourceGet**, plus PSGallery modules `Microsoft.WinGet.DSC` and `PSDscResources`.
- Creates locked-down layout under `C:\ProgramData\DscV3\` (`bin`, `runs`, `state`).
- Shallow-clones the **dsc-fleet** repo into a temp dir, copies `modules\DscV3.RegFile` to both `C:\Program Files\WindowsPowerShell\Modules\` and `C:\Program Files\PowerShell\Modules\`, copies `bootstrap\Invoke-DscRunner.ps1` and `bootstrap\DscFleet.Logging.psm1` into `C:\ProgramData\DscV3\bin\`, then deletes the clone (no platform repo history left on the VM).
- Writes `state\install.json` recording the platform commit SHA for audit.

What `Register-DashboardAgent.ps1` does:

- POSTs `/api/agents/register` with `{provisionToken, hostname, osCaption}` → receives `{agentId, agentApiKey}`.
- Persists `agent.config.json` to `C:\ProgramData\DscV3\` with SYSTEM + Administrators-only ACL.
- (If `-CredentialUrl` provided) POSTs to it with the provision token as bearer, receives `{username, kind, password?}`. Dashboard scrubs ciphertext after read.
- Re-registers scheduled task `DscV3-Apply` to invoke `Invoke-DscRunner.ps1 -Mode Dashboard` every 60s under the chosen principal (SYSTEM / password / gMSA, RunLevel `Highest`).
- Sends initial heartbeat — flips server status to **ready** in the dashboard.

### 6.4 Verify heartbeat

In the dashboard the server card should turn **green / ready** within 60s. From the VM:

```powershell
Get-Content 'C:\ProgramData\DscV3\state\agent.log' -Tail 50 -Wait
Get-ScheduledTaskInfo -TaskName 'DscV3-Apply'
```

---

## Phase 7 — Lab module deployment

There is **nothing to do for this phase** — `Install-DscV3.ps1` already copied `DscV3.RegFile` (v0.3.0; manifest at `C:\Source\dsc-fleet\modules\DscV3.RegFile\DscV3.RegFile.psd1`) into `C:\Program Files\PowerShell\Modules\DscV3.RegFile\` during Phase 6.

Verify on the VM:

```powershell
pwsh -NoProfile -Command "Get-Module -ListAvailable DscV3.RegFile | Format-Table Name, Version, ModuleBase"
pwsh -NoProfile -Command "dsc resource list --adapter Microsoft.DSC/PowerShell | Select-String RegFile"
```

To upgrade the module fleet-wide, push a new tag on `dsc-fleet`, then re-run `Install-DscV3.ps1 -PlatformRef <newTag>` on each VM (the dashboard's *re-bootstrap* action does this via Run Command).

---

## Phase 8 — Smoke test

```powershell
$rg  = 'dsc-fleet-dashboard'
$api = 'https://' + (az containerapp show -g $rg -n api --query properties.configuration.ingress.fqdn -o tsv)
$web = 'https://' + (az containerapp show -g $rg -n web --query properties.configuration.ingress.fqdn -o tsv)
"API: $api"; "Web: $web"
```

API smoke (per `azure/ENTRA-AUTH.md`):

```powershell
curl.exe -i "$api/healthz"             # 200 (anonymous, by design)
curl.exe -i "$api/api/servers"         # 401 Unauthorized (Bearer required)
```

Browser flow:

1. Open the web URL in a private window → expect redirect to `login.microsoftonline.com`.
2. Sign in with a tenant account → land on the dashboard (your name + Sign-out chip in the top nav).
3. **Servers** page lists `dsc-03` (or whatever you provisioned) as **ready**, last heartbeat < 1m ago.
4. **Configurations → New** → paste a small DSC v3 YAML using `RegFile` → save.
5. **Assign** the config to the server.
6. Wait for the next agent poll (≤60s) → run appears in the server's run history with green status.
7. Open the run → **Output drawer** is populated with `dsc.exe` stdout/stderr.
8. WebSocket connectivity: no “reconnecting…” toasts in the bottom-right; browser devtools shows an open `wss://api.../ws?access_token=...` frame.

---

## Teardown

Ordered to avoid leaving orphaned cross-RG role assignments, cached LSA secrets, or app registrations.

### T1. Quiesce the application data plane

In the dashboard UI (or via API):

1. Soft-delete every **assignment** (each goes through `removing` → `removed`; this dispatches a removal manifest to each agent).
2. Cancel any in-flight **jobs** (Jobs view → Cancel).
3. Wait until every assignment lands at `removed` or `removal_expired` — otherwise agents will keep applying state until ACK timeout (`REMOVAL_ACK_TIMEOUT_MINUTES`, default 60).

### T2. Deprovision agents on each VM

Either click *Deprovision* in the dashboard for each server (which Run-Commands a teardown), or manually on each VM:

```powershell
Unregister-ScheduledTask -TaskName 'DscV3-Apply' -Confirm:$false
Remove-Item 'C:\ProgramData\DscV3' -Recurse -Force
Remove-Item 'C:\Program Files\WindowsPowerShell\Modules\DscV3.RegFile' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\Program Files\PowerShell\Modules\DscV3.RegFile'        -Recurse -Force -ErrorAction SilentlyContinue
# Optional: drop the prereqs too
# choco uninstall pwsh git -y    # if you used choco; otherwise uninstall via Apps & Features
```

If you used a domain or local password run-as account, also delete the cached **LSA secret**:

```powershell
# Removing the scheduled task as above is sufficient — Windows drops the
# associated LSA secret automatically. Re-confirm with:
schtasks /Query /TN DscV3-Apply 2>$null   # should be empty
```

### T3. Stop / delete the lab VMs

```powershell
az vm deallocate -g dsc-v3 --name dsc-03
az vm delete    -g dsc-v3 --name dsc-03 --yes
# Repeat for each managed VM. Delete the lab RG only if you don't reuse it:
# az group delete -n dsc-v3 --yes --no-wait
```

### T4. Remove cross-RG (and any other) role assignments held by the UAMI

The dashboard's UAMI may hold role assignments **outside** the dashboard RG — at minimum **Virtual Machine Contributor** on RG `dsc-v3`, and potentially **Contributor** / **AcrPush** elsewhere if you wired up GHA OIDC (see `azure/README.md` § *GitHub Actions setup*). Deleting RG `dsc-fleet-dashboard` does NOT remove these — orphaned principal IDs linger on the higher-scoped assignments.

Capture the principal id **before** deleting the UAMI / its RG, then enumerate every assignment at every scope and delete by `--ids`:

```powershell
$uami = az identity show -g dsc-fleet-dashboard -n id-dsc-fleet-dashboard --query principalId -o tsv

# List EVERYTHING this principal holds across the whole subscription (and any
# higher scopes it was granted at). --all walks parent scopes too.
az role assignment list --assignee-object-id $uami --all -o table

# Capture and delete each by --ids (works for any scope: RG, subscription,
# resource, management group):
$ids = az role assignment list --assignee-object-id $uami --all --query '[].id' -o tsv
foreach ($id in $ids) {
    az role assignment delete --ids $id
}
```

Verify nothing remains (should be empty):

```powershell
az role assignment list --assignee-object-id $uami --all -o table
```

Only after this is clean should you proceed to T5 (which deletes the UAMI itself by removing the RG).

### T5. Delete the dashboard resource group

```powershell
az group delete -n dsc-fleet-dashboard --yes --no-wait
```

This drops: ACA env + the three Container Apps, ACR (and all images), Postgres flex server (and **all data + automated backups**), storage account (and the `pgdata` SMB share + any persisted run logs), Log Analytics workspace, UAMI.

> ⚠️ The Postgres server has 7 days of automated backups by default — after RG deletion they are unrecoverable. Take a `pg_dump` first if you might need the data:
> ```powershell
> pg_dump "host=$pg port=5432 dbname=dscfleet user=dscadmin password=$pw sslmode=require" `
>     --format=custom --file=dscfleet-$(Get-Date -Format yyyyMMdd).dump
> ```

### T6. Delete the Entra app registration

The order matters: **service principal first, app registration last.** Deleting the app reg first leaves an orphan SP with role assignments and federated credentials that you can no longer easily target by `appId`. This sequence matches `entra-setup.md` § *TEARDOWN* (steps 1–7).

```powershell
$appId = (Get-Content .azure/secrets.local.json | ConvertFrom-Json).entraClientId

# 1. Capture the service principal object id (needed for every step below).
$sp = az ad sp show --id $appId | ConvertFrom-Json

# 2. Revoke enterprise-app user/group assignments (the appRoleAssignedTo edge).
$assignments = az rest --method GET `
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo" `
    --query value -o json | ConvertFrom-Json
foreach ($a in $assignments) {
    az rest --method DELETE `
        --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignedTo/$($a.id)"
}

# 3. Revoke any delegated OAuth2 grants the SP holds (consents).
$grants = az rest --method GET `
    --uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=clientId eq '$($sp.id)'" `
    --query value -o json | ConvertFrom-Json
foreach ($g in $grants) {
    az rest --method DELETE --uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants/$($g.id)"
}

# 4. Delete every Azure RBAC role assignment the SP holds, at every scope.
$ids = az role assignment list --assignee $sp.id --all --query '[].id' -o tsv
foreach ($id in $ids) { az role assignment delete --ids $id }

# 5. Delete federated credentials on the APP REGISTRATION (see also T8 for the
#    UAMI side; the app reg side lives here because it dies with the app reg).
$fics = az ad app federated-credential list --id $appId --query '[].id' -o tsv
foreach ($fic in $fics) {
    az ad app federated-credential delete --id $appId --federated-credential-id $fic
}

# 6. Delete the service principal (enterprise app object).
az ad sp delete --id $sp.id

# 7. Finally delete the app registration itself.
az ad app delete --id $appId

# 8. Verify it's really gone (and not just soft-deleted in the recycle bin):
az ad app list --display-name 'DSC Fleet Dashboard' -o table
az ad sp list --filter "appId eq '$appId'" -o table     # expect []
az rest --method GET `
    --uri "https://graph.microsoft.com/v1.0/directory/deletedItems/microsoft.graph.application?`$filter=appId eq '$appId'"

# Hard-delete from the recycle bin if present:
# az rest --method DELETE --uri "https://graph.microsoft.com/v1.0/directory/deletedItems/<deletedObjectId>"
```

### T7. Clean up local secrets

```powershell
Remove-Item C:\Source\dsc-fleet-dashboard\.azure\secrets.local.json -Force
Remove-Item C:\Source\dsc-fleet-dashboard\.azure -Recurse -Force -ErrorAction SilentlyContinue
```

### T8. CURRENT-SESSION ARTIFACTS to double-check

These are easy to miss because they live outside the dashboard RG or outside Azure altogether:

- 🔴 **Entra app registration + service principal** `DSC Fleet Dashboard` (T6) — survive RG deletion.
- 🔴 **Cross-RG and any other role assignments** held by the UAMI (T4) — survive UAMI deletion as orphan principal ids.
- 🔴 **Federated credentials — TWO locations.** They live both on the UAMI *and* on the app registration, and must be deleted in both places before the parent identity is removed:

  ```powershell
  # 8a. UAMI federated credentials (e.g. for GHA OIDC; see azure/README.md
  # § 'GitHub Actions setup'). Run BEFORE deleting the dashboard RG (T5).
  az identity federated-credential list `
      -g dsc-fleet-dashboard --identity-name id-dsc-fleet-dashboard -o table
  $ficNames = az identity federated-credential list `
      -g dsc-fleet-dashboard --identity-name id-dsc-fleet-dashboard --query '[].name' -o tsv
  foreach ($n in $ficNames) {
      az identity federated-credential delete `
          -g dsc-fleet-dashboard --identity-name id-dsc-fleet-dashboard --name $n --yes
  }

  # 8b. App-registration federated credentials. Run BEFORE T6 step 7
  # (`az ad app delete`). Already covered as T6 step 5; listed here for
  # completeness so you don't forget the UAMI side.
  $appId = (Get-Content .azure/secrets.local.json | ConvertFrom-Json).entraClientId
  az ad app federated-credential list --id $appId -o table
  ```

  Sequence: delete federated creds on **both** identities first, then delete the SP + app reg (T6), then delete the dashboard RG (T5) which removes the UAMI itself.

- 🔴 **Postgres flex-server firewall rules** — any ad-hoc `dev-laptop` / `tmp-debug` / per-IP rules created during Phase 5 debug sessions. List and delete before T5 (deleting the RG drops them, but if you `pg_dump` on the way out per T5 you may have just re-added one):

  ```powershell
  $rg='dsc-fleet-dashboard'; $pgName='dsc-fleet-dashboard-pg'
  az postgres flexible-server firewall-rule list -g $rg -n $pgName -o table

  # Delete any ad-hoc rules. Keep AllowAllAzureServices until RG deletion so
  # ACA-originated traffic still works for any final api calls.
  az postgres flexible-server firewall-rule delete -g $rg -n $pgName --rule-name dev-laptop --yes
  az postgres flexible-server firewall-rule delete -g $rg -n $pgName --rule-name tmp-debug  --yes
  # …repeat for any other per-IP rules you find listed.
  ```

- 🟡 **Storage account file share `pgdata`** — only used in `postgresMode=container`; may contain a Postgres data directory + ad-hoc run-log dumps.
- 🟡 **`pg_dump` backup files** on your workstation (T5) — may contain credential ciphertext from `agent_credentials`.
- 🟡 **`.azure/secrets.local.json`** (T7) — contains `pgPassword`, `runAsMasterKey`, `entraTenantId`, `entraClientId`.
- 🟡 **Soft-deleted Key Vaults** — this solution does **not** provision a Key Vault, but if you added one out-of-band, purge it: `az keyvault purge -n <name> -l australiaeast`.
- 🟡 **Lab VM LSA secrets** (T2) for any password run-as accounts.

---

## Post-redeploy: re-register reused agents

If you tore down the dashboard (above) but kept the **lab VMs** (T3 deallocate-only, no `vm delete`) and now want to point them at a freshly-deployed dashboard, the agents will **not** auto-re-register. Each VM still has its old `agent.config.json` pointing at a dashboard FQDN that either no longer exists or now refuses its old API key.

For each reused VM:

1. **Stop the scheduled task** so it doesn't keep hammering the dead/old API:
   ```powershell
   Disable-ScheduledTask -TaskName 'DscV3-Apply'
   ```

2. **Remove or overwrite the old config** (the runner refuses to start if `agent.config.json` is present but invalid; safest is to delete and let the bootstrap re-create it):
   ```powershell
   Remove-Item 'C:\ProgramData\DscV3\agent.config.json' -Force -ErrorAction SilentlyContinue
   ```

3. In the **new** dashboard UI, add the server (or click *Reprovision* if it survived in the DB) → issue a fresh **provision token** and (if password run-as) a fresh **credential URL**. Re-enter run-as credentials in the dashboard's reprovision dialog if the master key was rotated as part of the redeploy (see `operations.md` § 10d).

4. **Re-run** `Register-DashboardAgent.ps1` on the VM with the new args:
   ```powershell
   & 'C:\Source\dsc-fleet\bootstrap\Register-DashboardAgent.ps1' `
       -DashboardUrl   'https://api.<newDefaultDomain>' `
       -ProvisionToken '<new-single-use-token>' `
       -CredentialUrl  '<new-single-use-url>'   # omit for SYSTEM run-as
   ```
   This re-creates `agent.config.json`, re-registers the `DscV3-Apply` scheduled task with the chosen principal, and re-enables it.

5. **Verify** the new config points at the new API FQDN and that a heartbeat reaches the new dashboard:
   ```powershell
   Get-Content 'C:\ProgramData\DscV3\agent.config.json' | ConvertFrom-Json |
       Select-Object DashboardUrl, AgentId
   Get-Content 'C:\ProgramData\DscV3\state\agent.log' -Tail 50 -Wait
   ```
   The dashboard's *Servers* page should show the host as **ready** within `pollIntervalSeconds` (default 60 s).

If you skip step 2, `Register-DashboardAgent.ps1` will overwrite the API key fields in the existing config but leave any stale `DashboardUrl` from a previous run — always good to clear and let it re-write from scratch.

---

## Recovery / common pitfalls

### Postgres connectivity

- **`FATAL: no pg_hba.conf entry for host ...`** — your egress IP isn't whitelisted on the flex server. Add a firewall rule (see Phase 5) or rely on the `AllowAllAzureServices` rule for ACA-originated traffic.
- **API logs `getaddrinfo ENOTFOUND <host>`** — `managedPgHost` output wasn't passed correctly. Re-run `deploy-apps.ps1` and confirm the bicep output `apiFqdn` resolves.
- **`SSL connection is required`** — `DATABASE_URL` is missing `&sslmode=require`. The bicep adds it automatically when `postgresMode=managed`; only an issue if you hand-edited the secret.

### ACR pull denied

```text
DENIED: requested access to the resource is denied
```

- The UAMI doesn't have **AcrPull** on the registry. Re-deploy Phase 2, or assign manually:
  ```powershell
  $uami = az identity show -g dsc-fleet-dashboard -n id-dsc-fleet-dashboard --query principalId -o tsv
  $acr  = az acr show -g dsc-fleet-dashboard -n dscfleetdscacr --query id -o tsv
  az role assignment create --assignee $uami --role AcrPull --scope $acr
  ```
- The Container App's `registries[].identity` doesn't reference the UAMI's resource id. Inspect `az containerapp show -g dsc-fleet-dashboard -n api -o json | ConvertFrom-Json | % { $_.properties.configuration.registries }`.

### Entra: audience mismatch

- API logs `verifyEntraJwt: aud mismatch` — the SPA is requesting a token for a different scope. Confirm `apps/web/src/lib/authConfig.ts` `apiRequest.scopes` is exactly `api://<clientId>/access_as_user`.
- The validator (`apps/api/src/lib/entraAuth.ts`) accepts `aud` as either `<clientId>` **or** `api://<clientId>` — anything else is a 401.

### Entra: redirect URI mismatch

- Browser shows `AADSTS50011: The redirect URI ... does not match`. The SPA URL changed (new ACA env, new domain). Re-run `setup-entra.ps1 -WebUrl https://web.<newDefaultDomain>` to add the new redirect URI.

### Web bundle missing `VITE_ENTRA_*`

- Devtools console error at module load. Build args weren't passed. Re-run `build-and-push.ps1 -Only web`. If `secrets.local.json` is missing, re-run `setup-entra.ps1` first.

### `:latest` not picked up after re-push

- ACA does not poll for tag changes. Pin to digest (Phase 4.3) or do `az containerapp revision restart`.

### `charmap` UnicodeEncodeError from `az acr build` on Windows

- Known cp1252 bug on Windows; `build-and-push.ps1` handles it by polling run status.

### API still returns 200 anonymously after deploy

- Old revision is still active. Inspect and deactivate:
  ```powershell
  az containerapp revision list -g dsc-fleet-dashboard -n api -o table
  az containerapp revision deactivate -g dsc-fleet-dashboard -n api --revision <old-revision-name>
  ```

### WS closes immediately with code 4401

- Token expired or signed by a different tenant. Clear `localStorage` in the browser and sign in again; check api logs for the rejection reason from `verifyEntraJwt`.
