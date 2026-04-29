# Data model

Source of truth: [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma).
Backing store: PostgreSQL 16 on Azure Database for PostgreSQL Flexible Server.
All timestamps are
`timestamptz`. Primary keys are application-generated UUIDs except where
noted.

## Entity overview

```
                  ┌──────────────────┐
                  │      Server      │
                  │  (servers)       │
                  └────────┬─────────┘
                           │ 1
            ┌──────────────┼──────────────────────┐
            │ N            │ N                    │ N
   ┌────────▼───────┐ ┌────▼─────────┐  ┌─────────▼──────────┐
   │   AgentKey     │ │ ServerModule │  │  AgentCredential   │
   │ (agent_keys)   │ │(server_modules)│ │(agent_credentials)│
   └────────────────┘ └──────────────┘  └────────────────────┘
            │ N
            │
   ┌────────▼─────────┐         ┌──────────────────┐
   │   Assignment     │ N    1  │      Config      │
   │ (assignments)    │◄────────┤    (configs)     │
   └────────┬─────────┘         └────────┬─────────┘
            │ N                          │ 1
            │                  ┌─────────▼──────────┐
            │                  │  ConfigRevision    │ N
            │                  │(config_revisions)  │◄──┐
            │                  └────────────────────┘   │ pinned_revision_id
            │                            ▲              │
            │ 1                          │ N            │
   ┌────────▼─────────┐                  │              │
   │    RunResult     │──────────────────┘              │
   │ (run_results)    │  config_revision_id             │
   └────────┬─────────┘                                 │
            │                                           │
            └────── pinned (optional) ──────────────────┘

   ┌──────────────────┐         ┌────────────────┐
   │       Job        │         │  AuditEvent    │     ┌───────────┐
   │     (jobs)       │         │ (audit_events) │     │  Setting  │
   └──────────────────┘         └────────────────┘     │(settings) │
   server_id (FK, nullable)     entity_type/entity_id  │ k/v JSONB │
                                (loose ref, no FK)     └───────────┘
```

Foreign-key edges (and their cascade behaviour):

| From | To | On delete |
| --- | --- | --- |
| `agent_keys.server_id` | `servers.id` | Cascade |
| `agent_credentials.server_id` | `servers.id` | Cascade |
| `server_modules.server_id` | `servers.id` | Cascade |
| `assignments.server_id` | `servers.id` | Cascade |
| `assignments.config_id` | `configs.id` | Cascade |
| `assignments.pinned_revision_id` | `config_revisions.id` | SetNull |
| `config_revisions.config_id` | `configs.id` | Cascade |
| `configs.current_revision_id` | `config_revisions.id` | SetNull |
| `jobs.server_id` | `servers.id` | Cascade (FK is nullable) |
| `run_results.assignment_id` | `assignments.id` | Cascade |
| `run_results.server_id` | `servers.id` | Cascade |
| `run_results.config_revision_id` | `config_revisions.id` | Restrict |

`audit_events.entity_id` is **not** a real FK — it is a loose reference so
that audit history survives row deletion of any entity.

## Models

### `Server` — `servers`

The Azure VM the dashboard manages.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `name` | text | Operator-visible label |
| `azure_subscription_id` | text | Tuple `(sub, rg, vm)` is unique among non-deleted rows via partial unique index `uniq_active_server_azure_target` |
| `azure_resource_group` | text | |
| `azure_vm_name` | text | |
| `agent_id` | uuid unique | Stable identifier embedded in agent provisioning script |
| `hostname`, `os_caption`, `os_version` | text/nullable | Discovered from heartbeat |
| `status` | enum `ServerStatus` | `pending / provisioning / ready / error / offline` |
| `last_heartbeat_at` | timestamptz | Drives the offline sweep in the scheduler |
| `last_error` | text | |
| `labels` | jsonb | Free-form operator metadata |
| `created_at`, `updated_at`, `deleted_at` | timestamptz | Soft delete via `deleted_at` |
| `run_as_kind` | text nullable | `null` ⇒ tasks run as `SYSTEM`. Otherwise `password` or `gmsa` — see [Run-as credential storage](#run-as-credential-storage) |
| `run_as_user` | text nullable | Username (UPN, `DOMAIN\user`, or gMSA `DOMAIN\svc$`) |
| `run_as_iv` / `run_as_ciphertext` / `run_as_auth_tag` | bytea | AES-256-GCM material; empty for `gmsa` and `system` |
| `run_as_updated_at` | timestamptz | |

Indexes: `(status)`, plus the partial unique mentioned above.

### `AgentKey` — `agent_keys`

SHA-256 hash of an agent API key. Multiple non-revoked rows per server are
allowed for zero-downtime rotation.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `server_id` | uuid FK | |
| `key_hash` | text | `sha256(plaintext)` — plaintext returned exactly once at register/rotate time |
| `created_at`, `last_used_at`, `revoked_at` | timestamptz | |

Indexes: `(server_id)`, `(key_hash)`.

### `AgentCredential` — `agent_credentials`

One-time run-as credential drop, fetched by the agent during bootstrap.
Detailed flow in [Run-as credential storage](#run-as-credential-storage).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `server_id` | uuid FK | |
| `job_id` | uuid nullable | The `provision` job that issued the credential |
| `provision_token` | text | Echoed by the agent — must match the issuing job's token |
| `url_token` | text unique | Random 256-bit URL-safe token; the URL the agent calls |
| `username`, `kind` | text | `kind` ∈ `password` / `gmsa` |
| `iv`, `ciphertext`, `auth_tag` | bytea | Empty for `gmsa` rows |
| `expires_at`, `consumed_at`, `created_at` | timestamptz | |

Indexes: `(server_id)`, `(expires_at)`.

### `ServerModule` — `server_modules`

Normalised projection of installed PowerShell modules per server. Composite
PK `(server_id, name)`; refreshed from agent heartbeat payloads.

| Field | Type |
| --- | --- |
| `server_id` | uuid FK (PK part) |
| `name` | text (PK part) |
| `installed_version` | text |
| `discovered_at` | timestamptz |

### `Config` — `configs`

A logical configuration name; revisions live in `config_revisions`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `name` | text | |
| `description` | text nullable | |
| `current_revision_id` | uuid nullable, **unique** | Points at the latest revision; nulled on revision delete (`SetNull`) |
| `created_at`, `updated_at`, `deleted_at` | timestamptz | Soft delete via `deleted_at` |

### `ConfigRevision` — `config_revisions`

**Immutable** snapshot of a YAML body. Never updated after insert.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `config_id` | uuid FK | |
| `version` | int | Unique with `config_id` (`uniq_config_version`) |
| `yaml_body` | text | Bytes-faithful operator-submitted YAML |
| `source_sha256` | text | SHA-256 of literal UTF-8 bytes — agent change-detection key |
| `semantic_sha256` | text | SHA-256 of canonical JSON (sorted keys) — used to suppress no-op revisions |
| `required_modules` | jsonb | `[{name, minimumVersion}, ...]` parsed from YAML |
| `parsed_resources` | jsonb | Extracted resource list for UI display |
| `created_at` | timestamptz | |

Indexes: `(config_id)`, `unique(config_id, version)`.

### `Assignment` — `assignments`

The mapping `(server, config) → run on a schedule`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `server_id`, `config_id` | uuid FK | Partial unique on `(server_id, config_id) WHERE lifecycle_state IN ('active','removing')` (raw-SQL migration) |
| `pinned_revision_id` | uuid nullable | Optional pin to a historical revision; otherwise the agent receives `current_revision_id` |
| `generation` | int | Bumped on re-assignment; agents echo it on every result; mismatch ⇒ 409 |
| `interval_minutes` | int default 15 | Agent compares against `next_due_at` |
| `enabled` | bool | |
| `lifecycle_state` | enum `AssignmentLifecycleState` | `active / removing / removed / removal_expired` |
| `prereq_status` | enum `AssignmentPrereqStatus` | `unknown / installing / ready / failed` — gate that the agent honours before applying |
| `next_due_at` | timestamptz | Computed by API + scheduler |
| `last_run_at`, `last_success_at`, `last_failure_at` | timestamptz | Surfaced in the UI |
| `last_status` | enum `AssignmentLastStatus` | `success / drift / error / never` |
| `last_exit_code` | int | |
| `removal_requested_at`, `removal_ack_at`, `removed_at` | timestamptz | Drive the removing → removed/expired transition |
| `created_at`, `updated_at` | timestamptz | |

Indexes: `(server_id)`, `(config_id)`, `(lifecycle_state)`, `(next_due_at)`,
plus the partial unique above.

### `Job` — `jobs`

Async background work. Currently used for `provision`, `prereq-install`,
`module-install`, `config-apply`, `uninstall-config`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `server_id` | uuid FK nullable | A few jobs are server-less |
| `type` | enum `JobType` | |
| `status` | enum `JobStatus` | `queued / running / success / failed / cancelled` |
| `payload` | jsonb | Job-type-specific input (provision script, module list, provisionToken, etc.) |
| `log` | text | Streamed stdout/stderr (mostly from Run-Command output) |
| `attempts`, `error_code` | int / text | |
| `requested_at`, `started_at`, `finished_at` | timestamptz | |

Indexes: `(server_id)`, `(status)`, `(type)`.

### `RunResult` — `run_results`

One row per agent-side `dsc config set` invocation. Idempotent on `run_id`:
re-POSTing the same `run_id` returns the existing row.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `assignment_id`, `server_id`, `config_revision_id` | uuid FK | `config_revision_id` is `Restrict`-on-delete so revisions can't disappear out from under historical results |
| `generation` | int | Must match `assignments.generation` on POST |
| `run_id` | uuid | Agent-supplied idempotency key |
| `exit_code`, `had_errors`, `in_desired_state` | int / bool / bool | |
| `duration_ms` | int | |
| `dsc_output` | jsonb | Full structured output of `dsc config set --output-format json` |
| `started_at`, `finished_at` | timestamptz | |

Indexes: `(assignment_id)`, `(server_id)`, `(finished_at)`.

### `AuditEvent` — `audit_events`

Append-only log of UI mutations, agent actions, and system transitions.
`entity_id` is a loose reference so events survive deletion of the underlying
entity.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `event_type` | text | e.g. `server.runas.set`, `runas.credential.issued`, `assignment.created` |
| `entity_type`, `entity_id` | text | Loose ref |
| `actor_type` | enum `ActorType` | `ui / agent / system` |
| `actor_id` | text nullable | Entra `oid` for `ui`, server `agent_id` for `agent` |
| `payload` | jsonb | Event-type-specific |
| `created_at` | timestamptz | |

Indexes: `(entity_id)`, `(entity_type, entity_id)`, `(created_at)`.

### `Setting` — `settings`

Key-value JSONB store for runtime tunables. Empty in v1.

## Lifecycle of a run

This is how a config goes from "operator clicks Save" to "row appears in the
Run output drawer".

```
 Operator              API                      Agent (on VM)
    │                   │                          │
    │  PUT /api/configs │                          │
    │ /:id (new YAML)   │ INSERT config_revisions  │
    │──────────────────►│ UPDATE configs           │
    │                   │   .current_revision_id   │
    │                   │                          │
    │  POST /api/       │                          │
    │   assignments     │ INSERT assignments       │
    │──────────────────►│   (lifecycle=active,     │
    │                   │    generation=1,         │
    │                   │    next_due_at=now)      │
    │                   │                          │
    │                   │     GET /agents/:id      │
    │                   │     /assignments?since=  │
    │                   │◄─────────────────────────│
    │                   │ 304 OR { assignments[] } │
    │                   │     etag + sourceSha256  │
    │                   │─────────────────────────►│
    │                   │                          │
    │                   │     GET /agents/:id      │
    │                   │     /revisions/:revId    │
    │                   │◄─────────────────────────│
    │                   │ { yamlBody, sha256, ...} │
    │                   │─────────────────────────►│
    │                   │                          │ dsc config set
    │                   │                          │ ──► writes JSON
    │                   │                          │     to stdout
    │                   │                          │
    │                   │     POST /agents/:id     │
    │                   │     /results             │
    │                   │     { generation,        │
    │                   │       run_id, exitCode,  │
    │                   │       inDesiredState,    │
    │                   │       dscOutput, ... }   │
    │                   │◄─────────────────────────│
    │                   │ INSERT run_results       │
    │                   │ UPDATE assignments       │
    │                   │   last_run_at, ...,      │
    │                   │   last_status            │
    │                   │ INSERT audit_events      │
    │                   │ broadcast(server:<id>,   │
    │                   │   'run.completed', ...)  │
    │                   │                          │
    │  WS frame on /ws  │                          │
    │ topic=server:<id> │                          │
    │◄──────────────────│                          │
    │ (UI invalidates   │                          │
    │  React Query keys │                          │
    │  → refetch run    │                          │
    │  results)         │                          │
```

### Routes that touch each table

| Table | Read by | Mutated by |
| --- | --- | --- |
| `servers` | `GET/PATCH /api/servers`, `GET /api/servers/:id`, agent register / heartbeat | `POST /api/servers`, `POST /api/servers/:id/provision`, `agents:register` (status→ready), `agents:heartbeat` (last_heartbeat_at), `scheduler:markOffline` |
| `agent_keys` | `agentAuth.authenticateAgent` (every agent call) | `agents:register`, `POST /api/servers/:id/rotate-key` |
| `agent_credentials` | `POST /api/agents/runas/:urlToken` | `POST /api/servers/:id/provision` (insert), the runas endpoint (sets `consumed_at`), scheduler scrub |
| `server_modules` | `GET /api/servers/:id/modules` | `agents:heartbeat` |
| `configs` | `GET /api/configs`, `GET /api/configs/:id` | `POST /api/configs`, `PATCH /api/configs/:id`, `DELETE /api/configs/:id` |
| `config_revisions` | `GET /api/agents/:id/revisions/:revId`, `GET /api/configs/:id/revisions` | `POST /api/configs`, `PATCH /api/configs/:id` (only when `semantic_sha256` changes) |
| `assignments` | `GET /api/agents/:id/assignments`, `GET /api/assignments`, scheduler | `POST/PATCH/DELETE /api/assignments`, `agents:results` (last_*), `agents:removal-ack`, `scheduler:expireStaleRemovals` |
| `jobs` | `GET /api/jobs`, in-process job runner | `POST /api/servers/:id/provision`, `POST /api/servers/:id/install-modules`, job runners (status), scheduler (re-fire stuck queued) |
| `run_results` | `GET /api/run-results`, `GET /api/run-results/:id` (drawer) | `POST /api/agents/:id/results` |
| `audit_events` | `GET /api/audit-events` | Every UI mutation, agent action, and system transition |
| `settings` | (unused in v1) | (unused in v1) |

## Run-as credential storage

The dashboard never returns plaintext run-as credentials in any API response.

### At rest (Server.run_as_*)

The persistent run-as configuration on `servers` is encrypted with
**AES-256-GCM** (`apps/api/src/lib/runasCrypto.ts`):

- Master key: `RUNAS_MASTER_KEY` env var, 32 bytes base64-encoded. Loaded
  once at boot. If unset, the API refuses to issue any password run-as URL
  (HTTP 503); SYSTEM and gMSA flows still work.
- Each `encrypt()` generates a fresh 12-byte IV (`run_as_iv`).
- Output is split across three columns: `run_as_iv`, `run_as_ciphertext`,
  `run_as_auth_tag` (16 bytes; AEAD tag detects tampering).
- For `kind = 'gmsa'` and `kind = 'system'` the bytea columns are empty —
  only the `run_as_kind` and `run_as_user` text columns carry meaning.
- The "current run-as" GET endpoint (`GET /api/servers/:id/run-as`) returns
  only `{ kind, user, updatedAt }`. Plaintext is **never** returned.

### One-time drop (AgentCredential)

When a `provision` job needs to hand a credential to the bootstrap script:

1. UI submits run-as creds with the provision request, **or** the API reuses
   the persisted block (so re-provision never silently downgrades to SYSTEM).
2. API encrypts with the same `RUNAS_MASTER_KEY`, inserts a row into
   `agent_credentials` with a fresh `url_token` and `provision_token`.
3. The Run-Command provisioning script contains only the URL
   `https://<dashboard>/api/agents/runas/<url_token>` — no plaintext.
4. The bootstrap script calls that URL with
   `Authorization: Bearer <provision_token>`.
5. The endpoint:
   - Verifies the bearer matches `provision_token` and the row is not
     consumed/expired.
   - Atomically sets `consumed_at`.
   - Returns `{ username, password, kind }` exactly once.
   - Subsequent calls return 410.
6. The scheduler scrubs `iv`/`ciphertext`/`auth_tag` from consumed and
   expired rows, leaving only the audit metadata.

### Rotation

Re-issuing creds is just `PUT /api/servers/:id/run-as` with a new block.
The API encrypts and overwrites the bytea columns; the next provision picks
up the new value automatically.
