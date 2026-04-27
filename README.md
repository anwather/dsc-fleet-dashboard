# dsc-fleet-dashboard

Self-hostable management dashboard for [DSC v3](https://aka.ms/dsc) on Windows Server fleets.

This is the **Phase 2** companion to [`dsc-fleet`](https://github.com/anwather/dsc-fleet) and
[`dsc-fleet-configs`](https://github.com/anwather/dsc-fleet-configs). Phase 1 agents pull config
YAML from a public Git URL; this dashboard is an **opt-in alternative delivery path** — agents
register, pull assignments + config bodies from the dashboard API, and post results back.

> Status: **early scaffolding (Phase 2 backend foundation).** Frontend and agent endpoints land
> in subsequent commits.

## Features (planned)

- One-click provisioning of Azure VMs with the DSC v3 prereqs (via Azure Run-Command).
- Author / upload configs in a Monaco editor; immutable revisions; per-assignment intervals.
- Per-server compliance, drift, last-run, and module-prereq status.
- WebSocket live updates; Postgres is the source of truth.
- Zero hardcoded org / subscription IDs — everything `.env`-driven.

## Architecture (short)

```
                  +------------------+
                  |   Web (React)    |  ← scaffold incoming
                  +---------+--------+
                            | HTTP + /ws
                  +---------v--------+      +---------------------+
                  |  API (Fastify)   |----->|  Postgres (Prisma)  |
                  +---+----------+---+      +---------------------+
                      |          |
   @azure/arm-compute |          | Bearer (agent_api_key)
                      v          v
              +-------+--+   +---+------------------+
              | Azure VM |   |  Windows Server      |
              | (Run-Cmd)|   |  Invoke-DscRunner.ps1|
              +----------+   |  -Mode Dashboard     |
                             +----------------------+
```

See `docs/` (coming soon) for full architecture and getting-started.

## Repository layout

```
dsc-fleet-dashboard/
├─ apps/
│  ├─ api/                # Node 20 + Fastify + Prisma + node-cron + ws
│  └─ web/                # React (scaffold incoming)
├─ packages/
│  └─ shared-types/       # DTOs shared between api + web
├─ docs/                  # getting-started, architecture, customisation
├─ docker-compose.yml     # postgres + api + web
└─ .env.example           # copy to .env before `up`
```

## Quick start (5 minutes)

> Requires Docker 24+ and ports `3000` (api), `5432` (postgres), `8080` (web placeholder) free.

```bash
git clone https://github.com/anwather/dsc-fleet-dashboard.git
cd dsc-fleet-dashboard
cp .env.example .env
# Optional: edit .env to add AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET
docker compose up --build
```

Then:

- Health check: <http://localhost:3000/healthz>
- Web placeholder: <http://localhost:8080/>

The API container runs `prisma migrate deploy` at startup, so the schema is always current
against the bundled Postgres on first up.

## Configuration

All runtime config lives in `.env`. See `.env.example` for the full list, including:

- `DATABASE_URL` — Postgres connection string (defaults to bundled).
- `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` — service principal for
  Run-Command. Optional; without these the API boots but provisioning endpoints fail closed.
- `AGENT_POLL_DEFAULT_SECONDS`, `OFFLINE_MULTIPLIER`, `DEFAULT_ASSIGNMENT_INTERVAL_MINUTES`.

## Required Azure RBAC

The service principal (or developer identity) used by the API needs, on every target VM:

- `Microsoft.Compute/virtualMachines/runCommand/action`

Built-in role: **Virtual Machine Contributor** (or a custom role with that one action if you
want to be tighter).

## Security posture (v1)

- **No authentication on UI routes** — designed for internal/private networks. Put behind your
  own reverse proxy with TLS + auth if exposing.
- **Per-agent API keys** are hashed at rest, multi-active to support rotation, and required as
  `Bearer` on all `/api/agents/*` endpoints.
- **Do not store secrets in config YAML.** DB backups contain config bodies. The UI surfaces
  a heuristic warning on save.

## Development

```bash
npm install                       # installs all workspaces
npm -w @dsc-fleet/api run build   # type-check + emit dist/
npm -w @dsc-fleet/api run dev     # ts-node dev server (requires local Postgres)
```

## License

MIT — see [LICENSE](LICENSE).
