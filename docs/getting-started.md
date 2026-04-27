# Getting started

This guide walks you from a fresh clone of the template to a running dashboard
managing a real Azure VM in about ten minutes.

## Prerequisites

You will need:

- **Either** Docker Desktop 24+ **or** [minikube](https://minikube.sigs.k8s.io/) +
  `kubectl` (for the Kubernetes path).
- `git`.
- Node 20+ is **only** needed if you want to run the api outside of containers
  (development workflow). The default path runs everything in containers.
- An **Azure subscription** plus an identity (developer login or service
  principal) with permission to invoke Run-Command on the VMs you want to
  manage. Concretely the identity needs the
  `Microsoft.Compute/virtualMachines/runCommand/action` data action — the
  built-in **Virtual Machine Contributor** role grants this. See
  [security-posture.md](security-posture.md#azure-service-principal) for the
  full breakdown.
- One or more Windows Server VMs in that subscription that can reach the
  dashboard URL over HTTP. The agent is the **outbound caller** — there are no
  inbound connections from the dashboard to the VM other than the
  Run-Command invocation that does the initial provisioning.

## Clone the template

This repo is intended to be **forked or cloned**, not run from
`anwather/dsc-fleet-dashboard` directly. Fork it into your own org if you plan
to customise (see [template-customisation.md](template-customisation.md)) or
shallow-clone for a tyre-kick:

```pwsh
git clone https://github.com/anwather/dsc-fleet-dashboard.git
cd dsc-fleet-dashboard
```

## Path 1 — Docker Compose (quickest)

This brings up Postgres 16, the Fastify api, and the React web UI behind nginx
in three containers.

### 1. Configure environment

```pwsh
Copy-Item .env.example .env
notepad .env
```

The defaults work as-is for a local-only run. The values you most often want
to change are:

| Variable | Default | Why change |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://dscfleet:dscfleet@postgres:5432/dscfleet?schema=public` | Point at an external Postgres instead of the bundled one. |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | (empty) | Required for VM provisioning. Leave blank for a UI-only walkthrough. |
| `AGENT_POLL_DEFAULT_SECONDS` | `60` | Lower for snappy demos, higher for large fleets. |
| `DEFAULT_ASSIGNMENT_INTERVAL_MINUTES` | `15` | Minimum assignment interval the UI suggests. |

The full list lives in [`.env.example`](../.env.example). The api fails fast at
boot if `DATABASE_URL` is missing — there is no in-app DB wizard.

### 2. Bring it up

```pwsh
docker compose up --build
```

On first boot the api container runs `prisma migrate deploy`, which creates
the schema in the bundled Postgres volume (`dsc_fleet_pgdata`). Subsequent
boots are no-ops.

### 3. Wait for `/healthz`

```pwsh
# In another shell:
Invoke-RestMethod http://localhost:3000/healthz
```

A healthy response looks like:

```json
{
  "status": "ok",
  "db": "ok",
  "azure": "ok",
  "azureError": null,
  "uptimeSeconds": 12
}
```

`azure` is one of `ok`, `unconfigured`, or `error`. `unconfigured` means no
service-principal env vars are set — the api still boots, but the **Provision**
flow will fail closed (see [Troubleshooting](#troubleshooting)).

### 4. Open the dashboard

<http://localhost:8080>

The root path redirects to the **Servers** page.

### 5. (Local dev only) Expose the dashboard to a remote VM

If your dev workstation runs the dashboard on `localhost` but the lab VM lives
in Azure, the VM has no route back to your loopback. For **short-lived local
development and validation only** you can use a Cloudflare Quick Tunnel to
hand the VM a temporary public URL:

```pwsh
# Requires cloudflared (winget install Cloudflare.cloudflared).
# Hands out a throwaway https://<random>.trycloudflare.com that proxies to :8080.
# No Cloudflare account, no DNS, no auth.
cloudflared tunnel --url http://localhost:8080
```

Use the printed `https://*.trycloudflare.com` URL as the dashboard URL when
you call `Register-DashboardAgent.ps1` on the VM (or set it as the API's
externally-visible base URL so provision jobs hand it to the VM).

> **This is not for real deployments.** The URL is unauthenticated, public to
> anyone who guesses it, and dies the moment `cloudflared` exits. For any
> real fleet host the dashboard on stable infrastructure (the
> [`k8s/`](../k8s/) manifests, App Service, etc.) and put auth in front.
> See [security-posture.md](security-posture.md).

## Path 2 — minikube

For lab environments where you want persistent Postgres storage that survives
host reboots, follow [`k8s/README.md`](../k8s/README.md). The summary loop is:

1. `minikube start --cpus=4 --memory=6g --disk-size=20g`
2. Point your docker CLI at minikube's docker daemon
   (`& minikube -p minikube docker-env --shell powershell | Invoke-Expression`)
3. `docker build` the api and web images locally
4. Edit `k8s/10-postgres-secret.yaml` and `k8s/20-api-config.yaml` (Azure SP)
5. `kubectl apply -f k8s/00-namespace.yaml` … through `40-ingress.yaml`
6. `minikube service web -n dsc-fleet` to open the UI

The api `Deployment` runs a single replica — see
[architecture.md](architecture.md#single-api-replica) for why.

## First-time walkthrough

The following five steps take you end-to-end against a real Azure VM. Each
step calls out the exact UI affordance and the underlying API/DB activity so
you can correlate what you see with what is happening.

### 1. Open the dashboard

After `docker compose up`, browse to <http://localhost:8080>. You land on the
**Servers** page with an empty list and a top nav bar across the page:
**Servers / Configs / Assignments / Jobs**. The status banner at the top is
green if `/healthz` returned `ok`, amber/red if Azure credentials are missing
or invalid.

### 2. Add a server

Click **Add Server** in the top right. The dialog asks for:

- **Azure subscription ID** (required)
- **Azure resource group** (required)
- **Azure VM name** (required, must match exactly)
- A friendly **name** (defaults to the VM name)
- Optional **labels** as a JSON object

On **Save**, the UI calls `POST /api/servers`, which:

1. Inserts a row into `servers` with `status = 'pending'` and a generated
   `agent_id` UUID.
2. Best-effort fires `POST /api/servers/:id/provision-token` (see step 3) so
   provisioning starts immediately. (The web bundle uses
   `/api/servers/:id/provision` — both paths route into the same handler when
   the api proxies legacy aliases; the canonical endpoint is
   `provision-token`.)

The new row appears in the table with a `pending` status pill.

### 3. Provision the agent

Click the row to open the **Server detail** page, then click the **Provision**
button (or wait — `Add Server` already kicked it off). What happens server-side:

1. The api mints a single-use **provision token** and inserts a `provision`
   job row whose `payload` carries the token, an `expiresAt`, the dashboard's
   own URL, and the URL of the `dsc-fleet/bootstrap` repo.
2. `runProvisionJob` (in `apps/api/src/services/jobs.ts`) downloads three
   PowerShell scripts from
   `https://raw.githubusercontent.com/anwather/dsc-fleet/main/bootstrap/`:
   `Install-Prerequisites.ps1`, `Install-DscV3.ps1`, and
   `Register-DashboardAgent.ps1`.
3. It packages them into a single PowerShell script and calls
   `@azure/arm-compute`'s `virtualMachines.beginRunCommand` with command
   `RunPowerShellScript` (see `apps/api/src/services/azureCompute.ts`). This
   is the **only** outbound connection from the api to the VM.
4. On the VM, `Register-DashboardAgent.ps1` posts to
   `POST /api/agents/register` with the provision token plus the discovered
   `hostname`, `osCaption`, and `osVersion`. The api returns a fresh
   `agentId` + `agentApiKey`; the script writes those to disk for the
   scheduled task to pick up.

The server status transitions `pending → provisioning → ready` and the
**Jobs** tab streams the script's stdout/stderr line-by-line over WebSocket
(`job:<id>` topic). Watch the `last_heartbeat_at` field tick once the
agent's scheduled task fires its first poll
(see [architecture.md](architecture.md#agent-poll-loop)).

### 4. Author a config

Open **Configs** in the top nav and click **New Config**. You have two
starting points:

- **Start from a sample** — pick one of the eight patterns (single registry
  value, bulk `.reg` import, winget package, MSI, PSGallery module,
  inline script, Windows service, Windows feature). The form on the right
  lets you fill in the parameters; the YAML is generated into the Monaco
  editor below in real time.
- **Blank** — start with the minimal example committed in
  `apps/web/src/lib/samples.ts` (`BLANK_YAML`).

Edit until you're happy, then **Save**. `POST /api/configs` calls
`parseConfigYaml` (`apps/api/src/services/yamlParser.ts`), which:

- Validates against the bundled DSC v3 schema
  (`https://aka.ms/dsc/schemas/v3/bundled/config/document.json`).
- Walks `resources[]` (recursing into `Microsoft.Windows/WindowsPowerShell`
  and `Microsoft.DSC/PowerShell` adapters) and extracts the namespace prefix
  of each `type`. Known prefixes (`Microsoft.WinGet.DSC`, `PSDscResources`,
  `DscV3.RegFile`) are mapped to PSGallery module names; built-ins
  (`Microsoft.Windows`, `Microsoft.DSC`, `PSDesiredStateConfiguration`) are
  excluded.
- Computes two SHA-256 hashes: `sourceSha256` (exact UTF-8 bytes) and
  `semanticSha256` (canonical JSON, used to suppress no-op edits like
  whitespace changes).
- Inserts a new `config_revisions` row. On `PATCH /api/configs/:id` an edit
  whose `semanticSha256` matches the current revision is **not** stored as a
  new revision.

The right-hand sidebar of the editor shows the **Required modules** sourced
from the parser. A heuristic warning fires if the YAML contains substrings
like `password`, `secret`, `token`, or `credential` — the dashboard does not
support secret refs, and DB backups contain config bodies in plain text.
See [security-posture.md](security-posture.md#secrets).

### 5. Assign config to server

Open **Assignments**. The page renders a matrix with servers as rows and
configs as columns. Click the cell where your server and your new config
intersect. A dialog asks for an **interval (minutes)**; the default is the
value of `DEFAULT_ASSIGNMENT_INTERVAL_MINUTES` (15). **Confirm** to
`POST /api/assignments`, which:

1. Inserts an `assignments` row with `lifecycle_state = 'active'`,
   `generation = 1` (or `prior_generation + 1` if the same server×config pair
   was previously removed — see [architecture.md](architecture.md#partial-unique-on-assignments)),
   and `next_due_at = now + interval`.
2. Calls `reconcileAssignmentPrereq()` to inspect the revision's
   `requiredModules` against the rows in `server_modules` for that server.
   - If everything is present at the right version, `prereq_status = 'ready'`.
   - If a required module is missing, `prereq_status = 'unknown'`. Click the
     red badge in the matrix to fire `POST /api/servers/:id/install-modules`,
     which queues a `module_install` job that runs `Install-PSResource` via
     Run-Command. While the job runs, `prereq_status = 'installing'`.

### 6. Wait one poll cycle

The agent polls `GET /api/agents/:agentId/assignments?since=<etag>` every
`AGENT_POLL_DEFAULT_SECONDS` (60s by default). When it sees an assignment with
`lifecycle_state = 'active'`, `prereq_status = 'ready'`, and `now >= next_due_at`,
it:

1. Fetches the YAML body from
   `GET /api/agents/:agentId/revisions/:revisionId`.
2. Runs `dsc config set --document <tmp>.yaml --output-format json`.
3. Posts the result to `POST /api/agents/:agentId/results` with `runId`,
   `exitCode`, `hadErrors`, `inDesiredState`, `durationMs`, and the parsed
   `dscOutput`.

The api recomputes `next_due_at = finishedAt + intervalMinutes`, broadcasts
on the `server:<id>` WebSocket topic, and updates `last_status` to one of
`success`, `drift`, or `error`. Open the **Run history** tab on the server
detail page to see the most recent results with drill-down to the raw `dsc`
JSON output.

## Troubleshooting

### `/healthz` reports `azure: "unconfigured"` or `azure: "error"`

- `unconfigured` means none of `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET` are set in the api container's environment, **and**
  no `~/.azure` is mounted for `AzureCliCredential` fallback. Set the three
  env vars in `.env` and `docker compose up -d --force-recreate api`.
- `error` means `DefaultAzureCredential.getToken('https://management.azure.com/.default')`
  threw at boot. The exact error is in `azureError` in the `/healthz` JSON
  and in the api logs (`docker compose logs api`). Common causes: typo in the
  client secret, expired secret, tenant/client mismatch, or your network
  blocking the token endpoint.

### The agent never registers (server stays in `provisioning` or `pending`)

1. Open the **Jobs** tab and click the most recent `provision` job. The full
   stdout/stderr of the Run-Command invocation is captured here.
2. Common failures:
   - `Install-Prerequisites failed (exit ...)` — winget / PSResourceGet not
     installable on the VM. Patch the VM and rerun.
   - `Register-DashboardAgent failed` with a `Connection refused` — the VM
     can't reach the dashboard URL the api passed it
     (`req.protocol://req.headers.host`). Behind NAT? Set `WEB_PORT` /
     publish a reverse-proxy URL and rerun. For local dev see
     [step 5 — Expose the dashboard](#5-local-dev-only-expose-the-dashboard-to-a-remote-vm).
   - `provision token expired` (job `errorCode = TokenExpired`) — token
     lifetime is `AZURE_RUNCOMMAND_TIMEOUT_MINUTES` minutes from issue. Rerun
     **Provision** to mint a fresh one.

### "No run results" on a server detail page

Run results only appear once the agent has both polled, fetched a revision,
and posted back. Check, in order:

1. The agent has a fresh heartbeat (`last_heartbeat_at` on the server detail
   page is recent). No heartbeat means the scheduled task on the VM isn't
   running — log onto the VM and check Task Scheduler for `Invoke-DscRunner`.
2. The assignment's `prereq_status` is `ready`. If it's `unknown`, the agent
   silently skips the assignment because a required module is missing. Click
   the red module badge to install it.
3. The assignment's `next_due_at` is in the past. The scheduler backfills any
   `next_due_at = null` rows on its 30s tick, so wait 30s after a fresh
   assignment.

### Postgres data disappears after `docker compose down`

`docker compose down` (without `-v`) keeps the named volume `dsc_fleet_pgdata`.
`docker compose down -v` removes it. On minikube, the PVC
`pgdata-postgres-0` survives `minikube stop` and host reboots but is destroyed
by `minikube delete` — see [`k8s/README.md`](../k8s/README.md#persistent-storage).

## Where to next

- [architecture.md](architecture.md) for the data model, lifecycle state
  machines, and the reasoning behind the design choices.
- [template-customisation.md](template-customisation.md) for forking the
  dsc-fleet / dsc-fleet-configs URLs, adding sample configs, or extending the
  module allow-list.
- [security-posture.md](security-posture.md) for the v1 trust model and the
  v2 hardening backlog.
