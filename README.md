# DSC v3 Fleet Dashboard

A self-hostable web dashboard for managing Windows Server fleets with
[PowerShell DSC v3](https://learn.microsoft.com/powershell/dsc/overview).
Onboard Azure-hosted Windows VMs, author DSC v3 configurations in YAML,
assign them to servers on a polling schedule, and monitor drift and run
results — all from a single React UI backed by a Fastify + Postgres api.

This repository is published as a **template**. Fork it into your own
org, point a few URLs at your own GitHub repos and Azure subscription
(see [docs/template-customisation.md](docs/template-customisation.md)),
then deploy your fork to Azure following
[docs/deployment.md](docs/deployment.md). There is no hosted service.

## Deployment target

The supported deployment is **Azure Container Apps + Azure Database for
PostgreSQL Flexible Server + Microsoft Entra ID**, provisioned by the
Bicep templates and PowerShell scripts under [`azure/`](azure/). Local
docker-compose / minikube workflows are not supported and the related
files are not maintained.

## Quickstart

Follow [docs/deployment.md](docs/deployment.md) end-to-end. The
high-level shape — **run the four scripts under `azure/scripts/` in
this exact order**:

```powershell
# 0. (one-off) fork dsc-fleet-dashboard + dsc-fleet on github.com,
#    then clone both forks side-by-side under C:\Source\.
cd C:\Source\dsc-fleet-dashboard
az login
az account set --subscription <your-sub-id>

./azure/scripts/deploy.ps1           # 1. Bicep infra (RG, ACR, UAMI, ACA env, storage)
./azure/scripts/setup-entra.ps1      # 2. Entra app reg (auto-pulls web FQDN from Bicep outputs)
./azure/scripts/build-and-push.ps1   # 3. az acr build api + web images
./azure/scripts/deploy-apps.ps1      # 4. Container Apps + Postgres Flexible Server
```

Then from the dashboard UI: add your first VM (the api uses Azure
Run-Command to install DSC v3 + the agent), author a config from a
sample, assign it to the VM with an interval, and watch the run
history populate.

The full prerequisites list (Azure CLI, PowerShell 7, an Owner-rights
account, an Entra app-registration role) and the teardown / redeploy
procedure live in [docs/deployment.md](docs/deployment.md).

### Run-as credential encryption

The **Add server → Password run-as** flow needs an AES-256-GCM master
key (`RUNAS_MASTER_KEY`) on the api. `azure/scripts/deploy-apps.ps1`
generates this automatically and stores it as a Container Apps secret;
you don't need to manage it by hand for a fresh deploy. Rotate with
`deploy-apps.ps1 -RotateRunAsKey`. SYSTEM and gMSA run-as flows do not
use the key.

## Documentation

The full doc set lives in [`docs/`](docs/). Start with:

| Document | What's in it |
| --- | --- |
| [Deployment runbook](docs/deployment.md) | End-to-end deploy + teardown of the Azure (Container Apps + managed Postgres + Entra) stack. Includes phase ordering, redeploy delta, and reused-VM reprovision. |
| [Azure quickstart](azure/README.md) | Bicep + scripts reference for the Container Apps deployment. Companion to `deployment.md`. |
| [User guide](docs/user-guide.md) | Dashboard walkthrough — sign in, add servers, author configs, assign, schedule, read run output. |
| [DSC v3 authoring guide](docs/dsc-authoring.md) | Adapter selection rules (PS 5.1 vs PS 7), all 9 samples explained, `DscV3.RegFile` module reference, troubleshooting matrix. |
| [Operations](docs/operations.md) | Day-2 ops — heartbeat, logs, schedules, image rollout, Postgres admin, common remediations. |
| [Entra setup](docs/entra-setup.md) | App registration, redirect URIs, scopes, scripted + manual portal flow, teardown order. |
| [Architecture](docs/architecture.md) | Component diagram, current-state design (Entra + ACA + managed Flex Server). |
| [Data model](docs/data-model.md) | Postgres schema and lifecycle of a server / config / job / run-result. |
| [Template customisation](docs/template-customisation.md) | URLs / env vars / code locations to edit when forking. |
| [Security posture](docs/security-posture.md) | v1 trust model and v2 hardening backlog. |

## Repository layout

| Path | Contents |
| --- | --- |
| [`apps/api`](apps/api) | Fastify 5 api: routes, services, scheduler, Prisma schema and migrations. |
| [`apps/web`](apps/web) | React 18 + Vite + Tailwind UI. Built into static assets and served by nginx. |
| [`packages/shared-types`](packages/shared-types) | TypeScript types shared between api and web (assignment, run-result, audit, ws-event). |
| [`azure`](azure) | Bicep templates and PowerShell scripts for the Container Apps deployment. The supported deploy target. |
| [`docs`](docs) | This documentation. |

## Companion repositories

The dashboard pairs with one external repo:

- **[`anwather/dsc-fleet-dashboard`](https://github.com/anwather/dsc-fleet-dashboard)** —
  this repo. The web UI + api + Azure deployment scripts.
- **[`anwather/dsc-fleet`](https://github.com/anwather/dsc-fleet)** —
  the PowerShell agent and bootstrap scripts. The dashboard's provision
  job downloads `Install-Prerequisites.ps1`, `Install-DscV3.ps1`, and
  `Register-DashboardAgent.ps1` from the `bootstrap/` folder of this
  repo and runs them on the target VM via Azure Run-Command. The
  agent's scheduled task (`Invoke-DscRunner.ps1 -Mode Dashboard`)
  implements the poll / fetch-revision / run / post-result loop. Also
  hosts the `DscV3.RegFile` module used by the bulk-registry-import
  sample.

> The historical third repo `anwather/dsc-fleet-configs` is
> **archived** and no longer required. Sample DSC v3 configurations
> are now embedded directly in the web bundle (see
> `apps/web/src/lib/samples.ts`).

When you fork the dashboard for your own deployment you'll typically
fork both repos above. See
[docs/template-customisation.md](docs/template-customisation.md) for
the exact URLs to update.

## License

[MIT](LICENSE).
