# Azure infrastructure — `dsc-fleet-dashboard`

Operate-the-infra reference for the Azure Container Apps deployment of
dsc-fleet-dashboard. For the end-to-end deployment narrative (CI, smoke
tests, image promotion), see [`../docs/deployment.md`](../docs/deployment.md).

Region: `australiaeast`. Subscription: `01e2f327-74ac-451e-8ad9-1f923a06d634`.
Resource group: `dsc-fleet-dashboard`. Lab RG (cross-RG VM Contributor):
`dsc-v3`.

---

## What's in this folder

```
azure/
├── README.md                ← this file
├── ENTRA-AUTH.md            ← Entra app registration + auth wiring
├── bicep/
│   ├── main.bicep           ← subscription-scope entry point (creates RG + modules)
│   └── modules/
│       ├── logAnalytics.bicep
│       ├── acr.bicep
│       ├── identity.bicep
│       ├── crossRgRole.bicep
│       ├── storage.bicep
│       ├── containerEnv.bicep
│       ├── pgFlexible.bicep
│       └── apps.bicep
└── scripts/
    ├── deploy.ps1           ← Phase 1: infra only (deployApps=false)
    ├── build-and-push.ps1   ← Phase 2: az acr build → ACR
    ├── deploy-apps.ps1      ← Phase 3: full deploy (deployApps=true)
    └── setup-entra.ps1      ← App registration + .azure/secrets.local.json
```

There is no separate `*.bicepparam` file. Parameters are passed inline by the
PowerShell scripts; secrets live in git-ignored `.azure/secrets.local.json` at
repo root.

---

## Quickstart deploy

From a clean subscription, this is the minimum sequence to get the dashboard
live. Run from the repo root.

```powershell
# 0. Sign in
az login
az account set --subscription 01e2f327-74ac-451e-8ad9-1f923a06d634

# 1. Phase 1 — infra (RG, ACR, UAMI, storage, ACA env, Log Analytics)
./azure/scripts/deploy.ps1 -SkipWhatIf

# 2. Entra app registration → writes .azure/secrets.local.json
./azure/scripts/setup-entra.ps1

# 3. Phase 2 — build & push api + web images (server-side ACR build)
./azure/scripts/build-and-push.ps1

# 4. Phase 3 — deploy postgres flex + the three Container Apps
./azure/scripts/deploy-apps.ps1 -SkipWhatIf
```

Outputs from step 4 print the public web/api FQDNs. Open the web URL in
incognito → Entra sign-in → dashboard.

If you don't have role-assignment rights on the lab RG `dsc-v3`, add
`-SkipLabRbac` to step 1 and assign Virtual Machine Contributor manually
afterward.

---

## Per-bicep-module overview

### `main.bicep`
Subscription-scope orchestrator. Creates the `dsc-fleet-dashboard` resource
group and dispatches every module into it. `deployApps=false` (the default)
stops after the env is provisioned — used for Phase 1. `deployApps=true`
additionally provisions the Postgres flexible server (when
`postgresMode=managed`) and the three Container Apps. Outputs FQDNs, ACR
login server, UAMI client/principal IDs, and the ACA env id.

### `modules/logAnalytics.bicep`
PerGB2018 workspace `log-dsc-fleet-dashboard` with 30-day retention and a
1 GiB/day cap. Outputs `customerId` + `primarySharedKey` consumed by
`containerEnv.bicep`. No dependencies.

### `modules/acr.bicep`
Basic-SKU ACR `dscfleetdscacr` (suffix from `nameSuffix`). Admin user OFF —
all pulls go through the UAMI's AcrPull role assignment. Outputs `name`,
`resourceId`, `loginServer`. No dependencies.

### `modules/identity.bicep`
User-assigned managed identity `id-dsc-fleet-dashboard` and an in-RG
`AcrPull` role assignment against the ACR. Outputs `resourceId`,
`principalId`, `clientId`, `name`. Depends on `acr.bicep` (existing reference).

### `modules/crossRgRole.bicep`
Conditional (`assignVmContributor=true`). Deployed at the *lab* RG scope and
assigns built-in `Virtual Machine Contributor` to the UAMI principal so the
api can call Run-Command on `dsc-01`/`dsc-02`. Idempotent via deterministic
`guid()` name. Depends on `identity.bicep` output.

### `modules/storage.bicep`
StorageV2 LRS account `dscfleetdscsa` with a 100 GiB SMB share `pgdata`
(SMB 3.1.1, AES-256-GCM channel encryption). Shared-key access stays on —
ACA managed-env storage requires it. Outputs `name`, `resourceId`,
`pgShareName`. Used only for the legacy `postgresMode=container` path; the
storage account/share are still provisioned in `managed` mode but are
inert (Plan B fallback).

### `modules/containerEnv.bicep`
ACA managed environment `cae-dsc-fleet-dashboard` with the Consumption
workload profile, wired to the Log Analytics workspace, plus a managed-env
storage entry `pgdata` linking the SMB share. Outputs `environmentId`,
`environmentName`, `defaultDomain`. Depends on `logAnalytics`, `storage`.

### `modules/pgFlexible.bicep`
Conditional (`deployApps && postgresMode=='managed'`). Azure Database for
PostgreSQL Flexible Server, Burstable `Standard_B1ms`, 32 GiB autogrow,
PG 16, public network access with the `AllowAllAzureServices` (0.0.0.0)
firewall rule. Creates DB `dscfleet`. Outputs `fqdn`, `serverName`,
`databaseName`, `adminUser` (`dscadmin`). 7-day backup retention, no
geo-redundancy, no HA.

### `modules/apps.bicep`
Conditional (`deployApps=true`). Three Container Apps in the env:
- **`postgres`** — only when `postgresMode=='container'`; `postgres:16-alpine`
  on internal TCP 5432 with the SMB volume mount. Single replica.
- **`api`** — `dsc-fleet/api:<imageTag>` from ACR, external HTTPS on 3000.
  Pinned to `minReplicas=maxReplicas=1` because the agent scheduler is
  in-process. Pulls via UAMI; uses `DefaultAzureCredential` with
  `AZURE_CLIENT_ID` to invoke Run-Command on lab VMs. Env wires
  `DATABASE_URL`, `RUNAS_MASTER_KEY`, `ENTRA_TENANT_ID`,
  `ENTRA_API_CLIENT_ID`.
- **`web`** — `dsc-fleet/web:<imageTag>`, nginx, external HTTPS on 80.

Outputs `apiFqdn`, `webFqdn`, `postgresName`. Depends on `containerEnv`,
`acr`, `identity`, and (in managed mode) `pgFlexible`.

---

## Parameters

All parameters are on `main.bicep` and forwarded to modules. Defaults match
the production deployment.

| Name                  | Type    | Default                  | Description                                                                            | Used by                            |
|-----------------------|---------|--------------------------|----------------------------------------------------------------------------------------|------------------------------------|
| `location`            | string  | `australiaeast`          | Region for every resource. Pinned to the lab region.                                   | all modules                        |
| `rgName`              | string  | `dsc-fleet-dashboard`    | Target resource group; also seeds derived names (`log-…`, `id-…`, `cae-…`, `…-pg`).    | rg, all modules                    |
| `labRgName`           | string  | `dsc-v3`                 | Lab RG that holds the managed Windows VMs.                                             | crossRgRole                        |
| `assignVmContributor` | bool    | `true`                   | Assign VM Contributor on `labRgName` to the UAMI. Set `false` if you lack Owner there. | crossRgRole                        |
| `deployApps`          | bool    | `false`                  | Phase 3 toggle. Adds pgFlexible + apps modules.                                        | pgFlexible, apps                   |
| `imageTag`            | string  | `latest`                 | Tag for `dsc-fleet/api` and `dsc-fleet/web` in ACR.                                    | apps                               |
| `postgresMode`        | string  | `managed`                | `managed` (flex server) or `container` (in-env Postgres on SMB — discouraged).         | apps, pgFlexible (conditional)     |
| `pgPassword`          | secure  | `''`                     | Required when `deployApps=true`. Flex server admin password + `DATABASE_URL` secret.   | pgFlexible, apps                   |
| `runAsMasterKey`      | secure  | `''`                     | Base64 32 bytes. AES-256-GCM key for password run-as creds. Empty disables that UI.    | apps                               |
| `entraTenantId`       | string  | `''`                     | Entra tenant ID for SPA + API JWT validation. Required when `deployApps=true`.         | apps                               |
| `entraApiClientId`    | string  | `''`                     | Entra app client ID = API audience. Required when `deployApps=true`.                   | apps                               |
| `nameSuffix`          | string  | `dsc` (2–8 chars)        | Suffix for globally-unique names (`dscfleet<suffix>acr`, `dscfleet<suffix>sa`).        | acr, storage                       |
| `tags`                | object  | `{app, env, managedBy}`  | Applied to every resource for billing/inventory.                                       | all modules                        |

`scripts/deploy-apps.ps1` auto-generates `pgPassword` and `runAsMasterKey`
on first run and persists them to `.azure/secrets.local.json`. **Don't lose
that file** — losing `pgPassword` means losing the database (no automated
backup restore is currently wired); losing `runAsMasterKey` means losing all
encrypted run-as credentials.

---

## Restore from `pg_dump`

There are no automated backup scripts in this folder — restore is manual.
The flex server keeps 7 days of platform-level PITR backups
(`backupRetentionDays: 7`, no geo-redundancy) which can be restored via the
portal or `az postgres flexible-server restore`. For logical
dump/restore against the running server:

### Take a dump (run from any host with `psql`/`pg_dump` 16.x)

```powershell
$pwd  = (Get-Content .azure/secrets.local.json -Raw | ConvertFrom-Json).pgPassword
$host = 'dsc-fleet-dashboard-pg.postgres.database.azure.com'
$env:PGPASSWORD = $pwd

pg_dump --host $host --username dscadmin --dbname dscfleet `
        --format custom --no-owner --no-acl `
        --file dscfleet-$(Get-Date -Format yyyyMMdd-HHmmss).dump
```

### Restore

```powershell
# 1. (Optional, destructive) drop and recreate target DB. Prefer restoring
#    into a fresh DB name and then renaming once verified.
psql --host $host --username dscadmin --dbname postgres `
     --command "CREATE DATABASE dscfleet_restore;"

# 2. Stop the api so Prisma migrations don't race the restore.
az containerapp update -g dsc-fleet-dashboard -n api --min-replicas 0 --max-replicas 0

# 3. Restore the dump.
pg_restore --host $host --username dscadmin --dbname dscfleet_restore `
           --no-owner --no-acl --clean --if-exists `
           dscfleet-YYYYMMDD-HHMMSS.dump

# 4. Swap names (in psql against `postgres` db):
#    ALTER DATABASE dscfleet RENAME TO dscfleet_old;
#    ALTER DATABASE dscfleet_restore RENAME TO dscfleet;

# 5. Bring api back up.
az containerapp update -g dsc-fleet-dashboard -n api --min-replicas 1 --max-replicas 1
```

Note: `runAsMasterKey` must match the value used when the encrypted
credentials in the dump were written. Restoring to a different deployment
means re-entering all password run-as creds in the UI.

---

## GitHub Actions setup *(pending — todo `gha-oidc`)*

> ⚠️ **Not yet implemented.** This section documents the *intended* shape so
> the workflow can be added without redesign. Tracked under the
> `gha-oidc` todo.

### 1. Federated credential on the UAMI

The deployment UAMI (`id-dsc-fleet-dashboard`) needs a federated identity
credential pointed at this repo so workflows can `az login` via OIDC with
no client secret.

```powershell
$rg     = 'dsc-fleet-dashboard'
$uami   = 'id-dsc-fleet-dashboard'
$repo   = 'OWNER/dsc-fleet-dashboard'   # e.g. github user/org slash repo

az identity federated-credential create `
  --name gha-main `
  --identity-name $uami `
  --resource-group $rg `
  --issuer 'https://token.actions.githubusercontent.com' `
  --subject "repo:$repo:ref:refs/heads/main" `
  --audiences 'api://AzureADTokenExchange'
```

Add additional credentials for `pull_request` (`subject =
repo:OWNER/REPO:pull_request`) and any release branches as needed.

The UAMI also needs **Contributor** on the `dsc-fleet-dashboard` RG and
**AcrPush** on the ACR (it already has AcrPull). Assign:

```powershell
$uamiPid = az identity show -g $rg -n $uami --query principalId -o tsv
$rgId    = az group show -n $rg --query id -o tsv
$acrId   = az acr show -g $rg -n dscfleetdscacr --query id -o tsv
az role assignment create --assignee-object-id $uamiPid --assignee-principal-type ServicePrincipal --role Contributor --scope $rgId
az role assignment create --assignee-object-id $uamiPid --assignee-principal-type ServicePrincipal --role AcrPush     --scope $acrId
```

### 2. Repo secrets / variables

Set as **repository variables** (non-secret):
- `AZURE_CLIENT_ID` — UAMI clientId (from Phase 1 output `identityClientId`)
- `AZURE_TENANT_ID` — Entra tenant
- `AZURE_SUBSCRIPTION_ID` — `01e2f327-74ac-451e-8ad9-1f923a06d634`
- `ACR_NAME` — `dscfleetdscacr`

`pgPassword`, `runAsMasterKey`, etc. should remain in
`.azure/secrets.local.json` for manual deploys, or move to Key Vault and be
fetched at workflow runtime (preferred once `gha-oidc` lands).

### 3. `.github/workflows/azure-deploy.yml` (intended shape)

```yaml
name: azure-deploy
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write    # OIDC
  contents: read

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: azure/login@v2
        with:
          client-id:       ${{ vars.AZURE_CLIENT_ID }}
          tenant-id:       ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}

      - name: Build & push images (az acr build)
        run: pwsh ./azure/scripts/build-and-push.ps1 -Tag ${{ github.sha }}

      - name: Deploy apps
        env:
          PG_PASSWORD:       ${{ secrets.PG_PASSWORD }}
          RUNAS_MASTER_KEY:  ${{ secrets.RUNAS_MASTER_KEY }}
        run: pwsh ./azure/scripts/deploy-apps.ps1 -Tag ${{ github.sha }} -SkipWhatIf
```

`deploy-apps.ps1` would need a `-NonInteractive` switch (skip the
`Read-Host` confirmation when `-SkipWhatIf` is set — small follow-up).

---

## Cost notes

Rough monthly retail estimate, australiaeast, idle workload (post-Phase 3
with `deployApps=true, postgresMode=managed`):

| Resource                               | SKU / config                          | ~AUD / mo |
|----------------------------------------|---------------------------------------|-----------|
| Container Apps env (Consumption)       | 3 apps × 1 replica, 0.5–0.25 vCPU     | ~$15–25   |
| Postgres Flexible Server               | `Standard_B1ms` Burstable, 32 GiB SSD | ~$22–28   |
| Azure Container Registry               | Basic                                 | ~$8       |
| Storage account (Files + share)        | Standard LRS, 100 GiB share quota     | <$3 idle  |
| Log Analytics workspace                | PerGB2018, 1 GiB/day cap, 30-day ret. | <$5       |
| Public IPs / egress                    | Modest dashboard traffic              | <$2       |
| **Total (idle)**                       |                                       | **~$55–70 / mo** |

Levers if cost matters:
- Set `web`/`api` `minReplicas=0` (cold start ≈ 5–10 s; only safe if you
  drop the in-process scheduler).
- Drop the SMB share quota — it's billed on provisioned size, not used.
- Stop the flex server when not in use (`az postgres flexible-server stop`)
  — billing pauses for compute, storage still charges.

The 1 GiB/day Log Analytics cap is the single biggest accidental-cost
guardrail; don't raise it without a reason.

---

## Plan B — region/service failure recovery

There is **no warm DR**. Single region, single replica everywhere, no
cross-region storage replication, no geo-redundant Postgres backup. The
explicit fallbacks built into the templates are:

1. **Postgres flex outage** → flip `postgresMode=container` and redeploy.
   The SMB share + storage account still exist (they're always provisioned)
   so the in-env `postgres:16-alpine` container can take over with the
   `pgdata` volume. Caveat: chmod on Azure Files is best-effort and known
   to corrupt data over time; use only as an emergency bridge.
2. **ACR outage** → switch the `apps.bicep` registries block to a public
   registry (Docker Hub) image temporarily, or pre-pull images to a
   secondary ACR in another region.
3. **Region outage (`australiaeast`)** → no automated path. Manual recovery:
   - Re-deploy `main.bicep` with `-Location australiasoutheast` and a new
     `nameSuffix` (ACR + storage names are global).
   - Restore the latest `pg_dump` into the new flex server (see above).
   - Re-run `setup-entra.ps1` only if the SPA redirect URI changes
     (different web FQDN).
   - DNS / consumer apps need to be repointed manually — there is no
     Front Door / Traffic Manager in front.

If true HA matters, the cheapest meaningful upgrade path is:
- Flex server `highAvailability.mode = 'ZoneRedundant'` (~2× compute cost)
- `geoRedundantBackup: 'Enabled'`
- ACR Premium with geo-replication
- ACA env `zoneRedundant: true` (requires VNet integration)

None of these are enabled today — see [`../docs/deployment.md`](../docs/deployment.md)
for the rationale and the long-term roadmap.
