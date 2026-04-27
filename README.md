# DSC v3 Fleet Dashboard

A self-hostable web dashboard for managing Windows Server fleets with
[PowerShell DSC v3](https://learn.microsoft.com/powershell/dsc/overview).
Use it to onboard Azure-hosted Windows VMs, author DSC v3 configurations
in YAML, assign them to servers on a polling schedule, and monitor drift
and run results — all from a single React UI backed by a Fastify + Postgres
api.

This repository is published as a **template**. The expectation is that
you fork it into your own org, point a few URLs at your own GitHub
repos and Azure subscription (see
[docs/template-customisation.md](docs/template-customisation.md)), and run
your fork. There is no hosted service.

## Quickstart

### Docker Compose

```pwsh
git clone https://github.com/anwather/dsc-fleet-dashboard.git
cd dsc-fleet-dashboard
Copy-Item .env.example .env
# edit .env to add AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
docker compose up --build
```

Then browse <http://localhost:8080>. See
[docs/getting-started.md](docs/getting-started.md) for the full
walkthrough including adding your first server, authoring a config from a
sample, and the assignment matrix.

### minikube

```pwsh
git clone https://github.com/anwather/dsc-fleet-dashboard.git
cd dsc-fleet-dashboard
Copy-Item .env.example .env   # then edit AZURE_* (optional for non-Azure work)
minikube start --cpus=4 --memory=6g --disk-size=20g
.\scripts\deploy-minikube.ps1
minikube service web -n dsc-fleet
```

`scripts\deploy-minikube.ps1` (and the parallel `scripts/deploy-minikube.sh`)
is the one-shot deployer: it switches your shell to the minikube docker
daemon, builds both images, applies all manifests via `k8s\Apply-FromEnv.ps1`,
restarts the deployments, and waits for rollouts. Re-run it any time after
code changes — `--rebuild-only`, `--apply-only`, and `--no-wait` flags are
available for tighter loops.

For the per-manifest walkthrough and ops/troubleshooting, see
[`k8s/README.md`](k8s/README.md). The cluster bundles a single-replica
Postgres `StatefulSet` with a PVC for durable storage between
`minikube stop` cycles.

### Recent UI changes

- Every list view (Servers, Configs, Assignments, Jobs) and the Server
  detail page have a refresh button that invalidates their queries on
  click.
- The Server detail page opens on a new **Prereqs** tab showing the latest
  provisioning + module-install jobs and a required-vs-installed module
  table. Two buttons re-trigger provisioning or install only the modules
  that are missing.
- The Servers list now has a coloured/underlined name link, an explicit
  **View →** button, and a **Trash** icon for soft-removing the server
  (DELETE → soft-delete; assignments and run history are kept). The
  Server detail page header has the same Remove action.
- Assignments is no longer a Server×Config matrix. It's now a per-server
  list with config chips; click a chip to edit interval, jump to the
  config or server, or remove the assignment. The "Bulk Install" column
  is gone — that lives on the Prereqs tab now with the actual module list.
- Add Server now correctly fires the provisioning job (the dialog used to
  POST the wrong route, so the server row appeared but no job ran). The
  returned `jobId` is shown in the success toast.
- The config editor flags an empty Name with helper text and a tooltip on
  the disabled Create button so it's no longer a silent dead end.

## Documentation

| Document | What's in it |
| --- | --- |
| [Getting started](docs/getting-started.md) | Prerequisites, two install paths, end-to-end first-time walkthrough, troubleshooting. |
| [Architecture](docs/architecture.md) | Component diagram, data model, lifecycle state machines, design rationale. |
| [Template customisation](docs/template-customisation.md) | The handful of URLs, env vars, and code locations you'll edit when forking. |
| [Security posture](docs/security-posture.md) | v1 trust model (no auth, internal-only) and v2 hardening backlog. |
| [Kubernetes deployment](k8s/README.md) | minikube quickstart and per-manifest explanation. |

## Repository layout

| Path | Contents |
| --- | --- |
| [`apps/api`](apps/api) | Fastify 5 api: routes, services, scheduler, Prisma schema and migrations. |
| [`apps/web`](apps/web) | React 18 + Vite + Tailwind UI. Built into static assets and served by nginx. |
| [`packages/shared-types`](packages/shared-types) | TypeScript types shared between api and web (assignment, run-result, audit, ws-event). |
| [`k8s`](k8s) | Kubernetes manifests for minikube / lab clusters. |
| [`scripts`](scripts) | One-shot deploy scripts (`deploy-minikube.ps1`, `deploy-minikube.sh`). |
| [`docs`](docs) | This documentation. |
| [`.env.example`](.env.example) | Documented environment variables for the api container. |
| [`docker-compose.yml`](docker-compose.yml) | Bundled Postgres + api + web stack. |

## Companion repositories

The dashboard is one of three repos that make up the fleet system:

- **[`anwather/dsc-fleet-dashboard`](https://github.com/anwather/dsc-fleet-dashboard)** —
  this repo. The web UI + api.
- **[`anwather/dsc-fleet`](https://github.com/anwather/dsc-fleet)** —
  the PowerShell agent and bootstrap scripts. The dashboard's provision
  job downloads `Install-Prerequisites.ps1`, `Install-DscV3.ps1`, and
  `Register-DashboardAgent.ps1` from the `bootstrap/` folder of this repo
  and runs them on the target VM via Azure Run-Command. The agent's
  scheduled task (`Invoke-DscRunner.ps1 -Mode Dashboard`) implements the
  poll / fetch-revision / run / post-result loop.
- **[`anwather/dsc-fleet-configs`](https://github.com/anwather/dsc-fleet-configs)** —
  sample DSC v3 configurations. The eight starter samples surfaced by the
  Configs editor in this dashboard mirror the patterns committed there;
  the agent's Phase-1 `-Mode Git` also pulls directly from this repo.

When you fork the dashboard for your own deployment, you'll typically
fork all three. See
[docs/template-customisation.md](docs/template-customisation.md) for the
exact URLs to update.

## License

[MIT](LICENSE).
