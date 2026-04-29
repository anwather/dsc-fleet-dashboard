# Operations / Day‑2 guide

This is the runbook for an already-deployed dsc-fleet-dashboard. It covers
how the moving parts behave at runtime, where to look when something is
off, and the routine cleanup that should happen on a schedule.

For first‑time install see [`getting-started.md`](getting-started.md). For
the wire-level layout see [`architecture.md`](architecture.md).

---

## 1. Unified logging model

There is **one** log file per agent host:

```
C:\ProgramData\DscV3\state\agent.log
```

Every bootstrap script and the runner write through `DscFleet.Logging.psm1`
(`bootstrap/DscFleet.Logging.psm1` in the `dsc-fleet` repo). Concurrency is
serialised with a local named mutex (`Local\DscFleetAgentLog`) so the
SYSTEM-context scheduled task and an interactive admin shell can't tear
each other's lines.

Format:

```
2025-04-29T10:14:22.871Z [Runner] [INFO] heartbeat ok (42 module(s) reported, server time …)
```

Component labels (`Install`, `Prereq`, `Register`, `Runner`, `RunAs`,
`Removal`) let you `Select-String -Path agent.log -Pattern '\[Runner\]'`
to scope to a phase.

**Rotation:** at 5 MB the module renames `agent.log → agent.log.1 →
agent.log.2`, dropping the oldest. Two rotated copies are kept.

**Redaction:** before any line hits disk, `Format-DscFleetLogMessage`
substitutes `<redacted>` for `Authorization: Bearer …`,
`ProvisionToken=…`, `AgentApiKey=…`, `password=…`, and the credential
URL path (`/api/agents/runas/<token>`). Logs are still considered
sensitive (hostnames, module names) — treat them like config files.

**Logs do not ship anywhere automatically.** There is no agent-side log
forwarder. To collect logs centrally:

* Pull on demand: `az vm run-command invoke … --scripts "Get-Content C:\ProgramData\DscV3\state\agent.log -Tail 500"`.
* Or wire your own Azure Monitor Agent / DCR if you need them in Log Analytics.

**Run correlation.** When the runner applies a config it writes a local
copy of the result JSON to `C:\ProgramData\DscV3\runs\<runId>.json`
*and* POSTs the same payload to `POST /api/agents/{id}/results`
(`apps/api/src/routes/agents.ts`, the `ResultsBody` block). The API stores
the full `dscOutput` as JSONB on `run_results`. To correlate a single run:

| You have | Find it via |
| --- | --- |
| `runId` (GUID) in agent.log | `SELECT * FROM run_results WHERE run_id = '<guid>';` or `GET /api/run-results?…` then filter |
| API `runResultId` from UI | `GET /api/run-results/{id}` returns `runId` + `dscOutput` |
| Server name | `GET /api/run-results?serverId=<id>&take=100` (newest first) |

The agent's `runId` is the durable join key — it is in the agent log line
that initiated the call, in the local JSON capture, and in the
`run_results.run_id` column.

---

## 2. Heartbeat loop

**Cadence.** The scheduled task fires `Invoke-DscRunner.ps1 -Mode Dashboard`
every 60 s by default (configured at install time). Each cycle the runner
calls `POST /api/agents/{id}/heartbeat` *first*, **then** pulls assignments,
**then** applies anything due. Heartbeat is the single point that updates
`servers.last_heartbeat_at` and the `server_modules` table.

The interval the agent should use is owned by the API and returned with
every heartbeat / assignments response as `pollIntervalSeconds`
(defaults to `AGENT_POLL_DEFAULT_SECONDS`, env var, default `60`). To
change the fleet-wide poll interval:

```bash
# update the API env, then restart:
az containerapp update -g <rg> -n api \
  --set-env-vars AGENT_POLL_DEFAULT_SECONDS=30
```

The agent picks the new value up on its next heartbeat cycle (it does not
yet auto-reconfigure the scheduled task — you still need to update the
task interval if you want the agent to actually fire faster).

**Heartbeat body** (see `HeartbeatBody` in `apps/api/src/routes/agents.ts`):

```json
{
  "osCaption": "Microsoft Windows Server 2022 Datacenter",
  "osVersion": "10.0.20348",
  "dscExeVersion": "3.0.2",
  "agentVersion": "0.1.0-dashboard",
  "modules": [{ "name": "ComputerManagementDsc", "version": "9.1.0" }, …],
  "serverTime": "2025-04-29T10:14:22.871Z"
}
```

Side effects on the API: upserts every reported module into
`server_modules`, then re-runs `reconcileAssignmentPrereq` for every
active assignment on this server, then broadcasts a WS frame on
`server:<id>` of type `heartbeat`.

**Detecting a stale agent.**

The scheduler tick (every 30 s) marks servers offline when:

```
last_heartbeat_at < now − OFFLINE_MULTIPLIER * AGENT_POLL_DEFAULT_SECONDS
```

(default `3 × 60 s = 180 s`). The status flip emits a WS event and
the server card in the UI turns grey. To investigate:

```sql
SELECT id, hostname, status, last_heartbeat_at,
       now() - last_heartbeat_at AS silent_for
FROM servers
WHERE deleted_at IS NULL
ORDER BY last_heartbeat_at NULLS FIRST;
```

Then on the host:

```powershell
Get-ScheduledTask -TaskName 'DscV3-Apply' | Get-ScheduledTaskInfo
Get-Content C:\ProgramData\DscV3\state\agent.log -Tail 100
```

The "Last heartbeat" timestamp shown in the UI server detail page is
literally `servers.last_heartbeat_at` rendered in the operator's local
time zone; the `heartbeat` WS event refreshes it without a page reload.

---

## 3. Reprovisioning flow

A "reprovision" replaces the agent's API key (and optionally its run-as
identity) without touching DSC state. End-to-end:

1. **Operator clicks "Reprovision"** in the UI → the web app POSTs
   `/api/servers/{id}/provision-token` (or `/provision`, same handler —
   `issueProvision` in `apps/api/src/routes/servers.ts`).
2. The API generates a fresh **provision token** (`generateToken(32)` → 32-byte
   base64url, see `apps/api/src/lib/tokens.ts`) and an `expiresAt` of
   `now + AZURE_RUNCOMMAND_TIMEOUT_MINUTES` (default 30 min).
3. If the request body includes `runAs`, or the server has a persisted
   run-as identity, a row is created in `agent_credentials` and a
   single-use **credential URL**
   `https://<dashboard>/api/agents/runas/<urlToken>` is issued.
4. A `provision` job is enqueued (`createProvisionJob`) which Azure
   Run-Command-invokes the bootstrap script on the VM with the token
   (and optionally the credential URL) as parameters.
5. On the VM, `Register-DashboardAgent.ps1` calls `POST /api/agents/register`
   with `{ provisionToken, hostname, … }` (see `RegisterBody` in
   `agents.ts`). The API validates the token (must be on a `provision`
   job in `queued|running|failed` state and **not** past `expiresAt`),
   issues a fresh agent API key, hashes it into `agent_keys`, marks the
   provision job `success`, and returns the **plaintext key once**.
6. The bootstrap writes the new key into
   `C:\ProgramData\DscV3\agent.config.json`. From the next heartbeat the
   agent uses the new key.

**Provision token lifecycle:**

| State | Storage | Means |
| --- | --- | --- |
| Issued | `jobs.payload->>'token'` on the `provision` job | Awaiting agent registration |
| Expired | `jobs.payload->>'expiresAt'` < now | `/register` returns `401 provision token expired` |
| Consumed | Provision job moved to `success` | Token row remains for audit, but `/register` will only match on `queued|running|failed`, so a second registration fails |

There is **no `DELETE /provision-token`**. Burning a token = letting it
expire (default 30 min) or marking the job `success`.

**Credential re-prompt.** The new run-as flow stores the password (when
`kind: 'password'`) AES-256-GCM-encrypted on `servers.run_as_*`. On
reprovision:

* `runAs: undefined` (no field in body) → reuse the persisted identity.
  If it's `kind: 'password'` and `RUNAS_MASTER_KEY` is unset on the API,
  the API returns 503 — re-supply the password.
* `runAs: null` → clear the persisted identity, agent runs as SYSTEM.
* `runAs: { kind, user, password? }` → overrides and persists.

So the operator only needs to **re-prompt for the password** if the
master key has been rotated or lost. gMSA never needs a password.

**What a reprovision actually does on the agent:**

* Replaces `agent.config.json` (`AgentApiKey` field) — old key still
  exists in `agent_keys` but the hash will not match a fresh API call.
* Optionally rewrites the scheduled-task principal if a new run-as was
  supplied.
* Does **not** uninstall any DSC modules, reset assignment generation,
  or wipe `C:\ProgramData\DscV3\runs\`. To do those things, use the
  separate "Reset" actions or `scripts/Reset-DscV3Server.ps1`.

To revoke an agent without reprovisioning, delete its row in `agent_keys`:

```sql
DELETE FROM agent_keys WHERE server_id = '<server-uuid>';
```

The next heartbeat will get `401`. (There is no soft-disable yet — open
issue.)

---

## 4. Scheduler

There are **two** schedulers and they do completely different things:

### 4a. The API's maintenance tick (`apps/api/src/services/scheduler.ts`)

`node-cron` running inside the API container, fires every 30 s
(`'*/30 * * * * *'`). One tick does, in order:

1. `markOffline()` — flip `ready → offline` for stale heartbeats.
2. `expireStaleRemovals()` — assignments stuck in `removing` for more
   than `15 × intervalMinutes` flip to `removal_expired`.
3. `backfillNextDueAt()` — newly created `active` assignments with
   `next_due_at = NULL` get `created_at + intervalMinutes`.
4. `reconcilePrereqStatus()` — if all `requiredModules` for a non-ready
   assignment are now in `server_modules`, flip `prereq_status → ready`.
5. `reapStuckJobs()` — re-fire queued jobs that nothing kicked off.
6. `sweepRunAsCredentials()` — see § 10.

This loop **does not run DSC**. It is purely DB reconciliation. Logs
land in the API container's `pino` stream (`az containerapp logs show -n api`
or `az containerapp logs show -g dsc-fleet-dashboard -n api --follow`).

### 4b. The agent's scheduled task

A Windows scheduled task (`DscV3-Apply`), created by
`Register-DashboardAgent.ps1`, fires `Invoke-DscRunner.ps1` every 60 s.
**This** is what actually executes DSC. It uses standard Windows Task
Scheduler triggers, not cron syntax — to change the cadence:

```powershell
$t = Get-ScheduledTask -TaskName 'DscV3-Apply'
$t.Triggers[0].Repetition.Interval = 'PT30S'   # 30s
Set-ScheduledTask -InputObject $t
```

### How schedules are stored

Per-assignment schedule lives on the `assignments` table:

| Column | Meaning |
| --- | --- |
| `interval_minutes` | How often the agent should re-apply this assignment. |
| `next_due_at` | Earliest UTC instant the agent should run this assignment. |
| `generation` | Bumped any time the assignment changes shape (revision pin, interval change). The agent must echo the generation back; mismatched results are 409'd. |

There is **no cron expression** — only a plain "every N minutes". After
each successful POST to `/results`, the API writes
`next_due_at = finishedAt + intervalMinutes` (`apps/api/src/routes/agents.ts`,
the results handler).

### How the scheduler picks up changes

* **Interval change via PATCH /assignments/:id** — `intervalMinutes` is
  updated immediately; the next agent poll sees it. `next_due_at` is
  not retroactively recalculated; it is honoured as-is until the next
  successful run, then `+ new interval`.
* **New revision pinned** — `generation` is bumped *and* `next_due_at`
  is forced to `now()` so the next agent cycle picks it up
  (see `apps/api/src/routes/assignments.ts` line ~257 and
  `routes/configs.ts` line ~231). The agent's local ETag cache is
  invalidated by the new ETag (the server returns 200, not 304).

### "Run now" vs scheduled run

There is no dedicated `/run-now` endpoint. To force an immediate run, the
UI (or you, via curl) just sets `next_due_at = now()`:

```sql
UPDATE assignments SET next_due_at = now() WHERE id = '<assignment-id>';
```

The next agent cycle (within `pollIntervalSeconds`) will see
`now() >= next_due_at` and apply. The result and audit trail are
identical to a scheduled run — there is no "manual run" flag on
`run_results`; the only difference is timing.

If you want to force-run *bypassing* the per-assignment gating (e.g.
on-host triage), invoke the runner with `-Now`:

```powershell
& 'C:\ProgramData\DscV3\bin\Invoke-DscRunner.ps1' -Now
```

---

## 5. Postgres flex server ops

Production runs Azure Database for PostgreSQL Flexible Server (the
docker-compose `postgres:16-alpine` is for local dev only).

### Connection limits

The API uses a single Prisma client per replica with the default pool
(`connection_limit = num_cpus * 2 + 1`). Single API replica means
~5 connections steady-state. The Flex server's default `max_connections`
on a B-series SKU is 50; on GP it's higher. To raise:

```bash
az postgres flexible-server parameter set \
  -g dsc-fleet-dashboard -s <server-name> \
  --name max_connections --value 200
# requires a server restart:
az postgres flexible-server restart -g dsc-fleet-dashboard -n <server-name>
```

### Restart

```bash
az postgres flexible-server restart -g dsc-fleet-dashboard -n <server-name>
```

The API will throw `P1001: Can't reach database server` for the ~30 s
window; the scheduler tick will log a tick failure but resume on the
next 30 s tick. Heartbeats from agents will 500 — the agent retries on
the next cycle. **No data loss**, but expect a one-cycle gap in
freshness.

### Scaling

```bash
az postgres flexible-server update \
  -g dsc-fleet-dashboard -n <server-name> \
  --sku-name Standard_D2s_v3 --tier GeneralPurpose
```

Vertical scale incurs ~1–2 min of downtime. Storage can be grown
online; **storage cannot be shrunk** — over-provision is permanent.

### Backups

PITR is on by default. Default retention is **7 days**; raise for prod:

```bash
az postgres flexible-server update \
  -g dsc-fleet-dashboard -n <server-name> \
  --backup-retention 35
```

To restore to a new server (we never restore in place):

```bash
az postgres flexible-server restore \
  -g dsc-fleet-dashboard -n <new-name> \
  --source-server <server-name> \
  --restore-time '2025-04-29T09:30:00Z'
```

Then point `DATABASE_URL` (`az containerapp secret set …`) at the new
server.

### Firewall rules

```bash
az postgres flexible-server firewall-rule list \
  -g dsc-fleet-dashboard -n <server-name> -o table
```

> **⚠ Cleanup item — `tmp-debug` rule.**
> There is a long-pending `tmp-debug` firewall rule on the Postgres
> Flexible Server in the `dsc-fleet-dashboard` resource group that opens
> a developer IP range. **Delete it:**
>
> ```bash
> az postgres flexible-server firewall-rule delete \
>   -g dsc-fleet-dashboard -n <server-name> --rule-name tmp-debug --yes
> ```
>
> Production access should only be via the Container Apps' VNET-integrated
> outbound IP and the `AllowAzureServices` rule (or ideally a private
> endpoint).

---

## 6. Image rollout (ACR → ACA)

CI builds and pushes:

```
<acr-name>.azurecr.io/dsc-fleet/api:<git-sha>
<acr-name>.azurecr.io/dsc-fleet/web:<git-sha>
```

into the ACR attached to the `dsc-fleet-dashboard` resource group. **Push
to ACR does not roll out to Container Apps** — that step is manual.

Pin a Container App to a specific tag:

```bash
az containerapp update -g dsc-fleet-dashboard -n api \
  --image <acr-name>.azurecr.io/dsc-fleet/api:<sha>

az containerapp update -g dsc-fleet-dashboard -n web \
  --image <acr-name>.azurecr.io/dsc-fleet/web:<sha>
```

Each `update` creates a new revision; ACA shifts traffic 100 % to the
new revision (single-revision mode). Roll back by re-running the same
command with the previous SHA.

Verify what's actually live:

```bash
az containerapp show -g dsc-fleet-dashboard -n api \
  --query 'properties.template.containers[0].image' -o tsv
```

> **⚠ Pending rollout.**
> `dsc-fleet/api:44f0ae0` and `dsc-fleet/web:44f0ae0` are in ACR but
> **not yet rolled out** to the live Container Apps. That tag includes
> the run-output drawer on the run-results view and Monaco
> format-on-validate in the config editor. Roll out with the two
> `az containerapp update --image …:44f0ae0` commands above.

`tag list` to confirm what ACR has:

```bash
az acr repository show-tags -n <acr-name> --repository dsc-fleet/api -o table
```

---

## 7. Run-as credential model

End to end (`apps/api/src/lib/runasCrypto.ts`,
`apps/api/src/routes/agents.ts`, `apps/api/src/routes/servers.ts`):

* **At rest in Postgres**: `agent_credentials.iv` (12 B random),
  `ciphertext` (AES-256-GCM), `auth_tag` (16 B). Encrypted with
  `RUNAS_MASTER_KEY` (env var, base64 32 bytes — generate with
  `openssl rand -base64 32`).
* The same fields exist on `servers.run_as_*` for the persisted identity
  reused on subsequent reprovisions; same algorithm, same key.
* **The plaintext password is never logged** (the API uses pino with
  scrub patterns; the agent logger redacts `password=…`).
* When the bootstrap fetches the credential, the API does an **atomic
  single-use** SQL `UPDATE agent_credentials SET consumed_at = now()
  WHERE consumed_at IS NULL AND expires_at > now() AND provision_token = $1
  RETURNING …`. A second fetch returns 401.
* Immediately after returning the plaintext, the API **scrubs** `iv`,
  `ciphertext`, `auth_tag` to empty buffers. The row remains for audit
  (`url_token`, `consumed_at`, `username`) but the encrypted material
  is unrecoverable.
* On the agent, the password is held in process memory **only for the
  duration of the run**. It is passed to `dsc.exe` via the scheduled-task
  principal mechanism / `New-ScheduledTaskPrincipal`. It is **never
  written to disk** — not to `agent.config.json`, not to any `.runs/`
  capture, not to `agent.log`.
* AAD: `decrypt()` will throw on auth-tag mismatch — tampering with the
  ciphertext at rest cannot produce a usable plaintext.

To rotate `RUNAS_MASTER_KEY` see § 10.

To audit one credential's lifetime:

```sql
SELECT id, server_id, kind, username, created_at, expires_at, consumed_at
FROM agent_credentials
WHERE server_id = '<server-uuid>'
ORDER BY created_at DESC;
```

---

## 8. Audit events

`apps/api/src/plugins/audit.ts` decorates every Fastify request with
`req.audit({ eventType, entityType, entityId, payload })`. On any 2xx
response, queued events are flushed in a single `createMany`. **4xx and
5xx responses do not write audit rows** — failures are logged via pino,
not audited. (This is intentional: an audit row implies "this happened",
not "this was attempted".)

**What gets audited.**

| `event_type` | Source | Payload highlights |
| --- | --- | --- |
| `agent.registered` | `POST /api/agents/register` | `hostname`, `agentVersion` |
| `agent.run.posted` | `POST /api/agents/{id}/results` | `runId`, `exitCode`, `lastStatus`, `durationMs` |
| `agent.removal.success` / `.failed` | `POST /removal-ack` | `success`, agent message |
| `runas.credential.consumed` | `POST /agents/runas/:urlToken` | `kind`, `user` (no secret material) |
| `server.provision.requested` | `POST /servers/:id/provision-token` | `kind`, `user`, `expiresAt` |
| `server.created` / `.updated` / `.deleted` | UI mutations on `/servers` | per-route payloads |
| `assignment.*`, `config.*`, `revision.published`, etc. | UI mutations | per-route payloads |

`actor_type` is `agent`, `ui`, or `system`. `actor_id` is `agent:<agentId>`
for agent actions; for UI actions it is the Entra `oid` of the calling
user (when the auth plugin can resolve one).

**Retention.** Audit rows are written to the `audit_events` table and
**never deleted automatically**. Plan a periodic prune (§ 10) for any
deployment older than ~6 months.

**Querying.** UI: `/audit` page calls `GET /api/audit-events?entityType=…&entityId=…&take=…`
(`apps/api/src/routes/auditEvents.ts`). Direct SQL:

```sql
-- Everything for one server, last 7 days
SELECT created_at, event_type, actor_type, payload
FROM audit_events
WHERE entity_type = 'server' AND entity_id = '<server-uuid>'
  AND created_at > now() - interval '7 days'
ORDER BY created_at DESC;
```

---

## 9. WebSocket connection

`apps/api/src/plugins/websocket.ts` mounts `GET /ws`. Auth model:

* **Token-protected**: clients connect with `?access_token=<entra-jwt>`
  (the same JWT the SPA gets from MSAL). `verifyEntraJwt` validates
  signature, audience (`ENTRA_API_CLIENT_ID`), and required scope
  (`ENTRA_REQUIRED_SCOPE`, default `access_as_user`) before the upgrade
  is accepted. On failure the API returns `401`; the browser closes the
  socket immediately.
* WS messages from the API are **not authoritative** — the database
  remains the source of truth. WS frames are an optimisation that
  spares a refetch.

**Subscribe model.** After connect the server sends
`{ topic: 'system', type: 'welcome' }`. The client then sends:

```json
{ "action": "subscribe",   "topic": "server:<id>" }
{ "action": "unsubscribe", "topic": "job:<id>" }
```

Topics in use:

| Topic | Events you'll see |
| --- | --- |
| `server:<id>` | `status`, `heartbeat`, `run.posted`, `assignment.removed`, `assignment.removal_expired`, `assignment.prereq_ready` |
| `job:<id>` | `job.status`, `job.log` (provision / module-install streaming output) |
| `system` | `welcome` only |

**Browser side.** `apps/web` opens **one** socket per tab via the
`useWsTopic(topic, handler)` hook. The hook reference-counts subscriptions
so that mounting/unmounting many components touching the same topic only
fires one `subscribe`/`unsubscribe` pair. On token expiry MSAL silently
refreshes; the WS does not currently auto-reconnect with the new
token — operators may see "stale" cards after 1 h until they refresh.
(Tracked.)

To debug live:

```js
// In the browser console, on the dashboard origin:
const t = sessionStorage.getItem('msal.idtoken') /* or your access token store */;
const ws = new WebSocket(`wss://${location.host}/ws?access_token=${t}`);
ws.onmessage = e => console.log(JSON.parse(e.data));
ws.onopen = () => ws.send(JSON.stringify({action:'subscribe', topic:'server:<id>'}));
```

---

## 10. Cleanup / hygiene checklist

Run monthly (or wire into a scheduled job):

### a. Orphaned jobs

Anything in `queued` for > 1 h or `running` for > 1 h is almost
certainly stuck (the scheduler reaper handles most cases):

```sql
SELECT id, type, server_id, status, requested_at, started_at
FROM jobs
WHERE status IN ('queued','running')
  AND coalesce(started_at, requested_at) < now() - interval '1 hour';
```

If the `provision` Azure Run-Command actually crashed (Azure unavailable),
mark the job `failed` so a fresh one can be created:

```sql
UPDATE jobs SET status = 'failed', finished_at = now()
WHERE id = '<job-id>' AND status IN ('queued','running');
```

### b. Expired provision tokens

These are stored as JSONB on `jobs.payload`. There is no explicit
"expired" status — they're just unusable. Old `failed` provision jobs
older than 30 days can safely be archived/deleted:

```sql
DELETE FROM jobs
WHERE type = 'provision' AND status = 'failed'
  AND requested_at < now() - interval '30 days';
```

### c. Stale run-as credentials

The scheduler tick already does this every 30 s — but verify:

```sql
SELECT id, server_id, created_at, expires_at, consumed_at
FROM agent_credentials
WHERE consumed_at IS NULL AND expires_at < now();
-- expected: 0 rows (sweepRunAsCredentials deletes them)
```

If you see leftovers, either the scheduler tick is failing (check API
logs) or the API has been down. Manual cleanup:

```sql
DELETE FROM agent_credentials
WHERE consumed_at IS NULL AND expires_at < now();
```

### d. Rotating `RUNAS_MASTER_KEY`

There is **no in-place re-encryption** (yet). Rotation procedure:

1. Generate a new key: `openssl rand -base64 32`.
2. Apply it: `az containerapp secret set -g <rg> -n api --secrets runas-key=<new>` then update the env-ref.
3. **Wipe stored run-as identities** — they're encrypted with the old key:
   ```sql
   UPDATE servers SET
     run_as_kind = NULL, run_as_user = NULL,
     run_as_iv = ''::bytea, run_as_ciphertext = ''::bytea, run_as_auth_tag = ''::bytea,
     run_as_updated_at = now();
   DELETE FROM agent_credentials;
   ```
4. Reprovision each server that needs a non-SYSTEM run-as, supplying
   the password fresh.

Plan rotation during a maintenance window — between (3) and (4) any
agent that needs a run-as identity for an apply will run as SYSTEM.

### e. Vacuuming / pruning `audit_events`

The table grows linearly; nothing prunes it. For deployments older than
~6 months consider:

```sql
-- Keep 1 year, archive the rest
DELETE FROM audit_events WHERE created_at < now() - interval '1 year';
VACUUM (ANALYZE) audit_events;
```

(Manual `VACUUM` is rarely needed on Flex — autovacuum is on. Run it
explicitly only after a large `DELETE`.)

### f. Old run results

`run_results` also grows linearly and stores full `dscOutput` JSONB. If
you don't need run history beyond 90 days:

```sql
DELETE FROM run_results WHERE finished_at < now() - interval '90 days';
VACUUM (ANALYZE) run_results;
```

---

## Quick reference — where things live

| Thing | Path |
| --- | --- |
| API source | `apps/api/src/` |
| Scheduler tick | `apps/api/src/services/scheduler.ts` |
| Agent wire protocol | `apps/api/src/routes/agents.ts` |
| Run-as crypto | `apps/api/src/lib/runasCrypto.ts` |
| WebSocket | `apps/api/src/plugins/websocket.ts` |
| Audit plugin | `apps/api/src/plugins/audit.ts` |
| Agent runner | `dsc-fleet/bootstrap/Invoke-DscRunner.ps1` |
| Agent logger | `dsc-fleet/bootstrap/DscFleet.Logging.psm1` |
| Agent config (on host) | `C:\ProgramData\DscV3\agent.config.json` |
| Agent log (on host) | `C:\ProgramData\DscV3\state\agent.log` |
| Local run captures (on host) | `C:\ProgramData\DscV3\runs\<runId>.json` |
