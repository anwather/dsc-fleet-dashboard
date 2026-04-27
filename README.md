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

If you'd rather run on a local Kubernetes, see
[`k8s/README.md`](k8s/README.md) for the manifest set and minikube loop.
The cluster bundles a single-replica Postgres `StatefulSet` with a PVC for
durable storage between `minikube stop` cycles.

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
