# Deploying dsc-fleet-dashboard to local minikube

End-to-end guide for running the entire stack — Postgres, api, web — on a
minikube cluster on your workstation, with all configuration sourced from the
repo-root `.env` file. Persistent storage survives `minikube stop`,
`minikube start`, and host reboots; only `minikube delete` destroys data.

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Configure `.env` (including Azure SPN)](#2-configure-env-including-azure-spn)
3. [Start minikube](#3-start-minikube)
4. [Build images into the cluster](#4-build-images-into-the-cluster)
5. [Apply manifests from `.env`](#5-apply-manifests-from-env)
6. [Access the dashboard](#6-access-the-dashboard)
7. [Updating after code or `.env` changes](#7-updating-after-code-or-env-changes)
8. [Persistent storage and backups](#8-persistent-storage-and-backups)
9. [Common operations](#9-common-operations)
10. [Tear down](#10-tear-down)
11. [What's in this directory](#whats-in-this-directory)
12. [Troubleshooting](#troubleshooting)

## 1. Prerequisites

Install on your workstation (one-time):

| Tool             | Tested version       | Notes                                  |
| ---------------- | -------------------- | -------------------------------------- |
| Docker Desktop   | 4.x                  | minikube uses its docker daemon        |
| minikube         | 1.33+                | `winget install Kubernetes.minikube`   |
| kubectl          | 1.30+                | `winget install Kubernetes.kubectl`    |
| PowerShell       | 7.x (or built-in 5.1)| Used by `Apply-FromEnv.ps1`            |

Verify:

```pwsh
docker --version
minikube version
kubectl version --client
```

## 2. Configure `.env` (including Azure SPN)

```pwsh
cd C:\Source\dsc-fleet-dashboard
Copy-Item .env.example .env -Force   # if you don't already have a .env
notepad .env
```

The required keys for k8s are:

```ini
# Database — the bundled in-cluster postgres. Defaults work as-is.
DATABASE_URL=postgresql://dscfleet:dscfleet@postgres:5432/dscfleet?schema=public
POSTGRES_USER=dscfleet
POSTGRES_PASSWORD=dscfleet         # change this for anything not strictly local
POSTGRES_DB=dscfleet

# API
API_PORT=3000
LOG_LEVEL=info
NODE_ENV=production

# Azure Service Principal (for VM provisioning + Run-Command).
# Leave blank to skip Azure features — the api still boots and the UI works,
# but provisioning endpoints will return clear errors.
AZURE_TENANT_ID=<tenant guid>
AZURE_CLIENT_ID=<app/client guid>
AZURE_CLIENT_SECRET=<client secret value>
```

> **Important — `DATABASE_URL` host.** The host portion **must** be `postgres`
> (the in-cluster Service name), not `localhost`. The same `.env` file
> already works that way for `docker compose up`, so usually no change is
> needed — but if you customised it for local Node dev, switch it back
> before running the script. The script warns if it looks wrong.

### Creating an Azure Service Principal

If you don't already have one:

```pwsh
# Find the subscription you'll provision VMs in.
az account list --query "[?isDefault].{name:name, id:id}" -o table

# Create the SPN scoped to that subscription.
$sub = '<subscription-guid>'
$spn = az ad sp create-for-rbac `
    --name 'dsc-fleet-dashboard' `
    --role 'Virtual Machine Contributor' `
    --scopes "/subscriptions/$sub" `
    --years 1 `
    | ConvertFrom-Json

# Print the values to paste into .env (these are shown ONCE):
Write-Host "AZURE_TENANT_ID=$($spn.tenant)"
Write-Host "AZURE_CLIENT_ID=$($spn.appId)"
Write-Host "AZURE_CLIENT_SECRET=$($spn.password)"
```

The SPN needs `Virtual Machine Contributor` (or a custom role with
`Microsoft.Compute/virtualMachines/runCommand/action` and read on
`Microsoft.Compute/virtualMachines/*`) on every subscription/RG that contains
target VMs. For Arc-enrolled servers, also grant `Azure Connected Machine
Resource Administrator` on the Arc resource scope.

> `.env` is already in `.gitignore` — secrets stay on your machine.

## 3. Start minikube

```pwsh
# Profile + resources (tune to taste; these are the minimum we tested with).
minikube start --cpus=4 --memory=6g --disk-size=20g

# Verify.
minikube status
kubectl config current-context     # should say `minikube`

# (Optional) enable ingress add-on if you want hostname access on dsc-fleet.local
minikube addons enable ingress
```

## 4. Build images into the cluster

minikube runs its own docker daemon. Point your shell at it so `docker build`
loads images directly into the cluster, with no registry round-trip:

```pwsh
# Run this in EVERY shell session you use for building.
& minikube -p minikube docker-env --shell powershell | Invoke-Expression

# api image (Dockerfile expects the repo root as build context)
docker build -t dsc-fleet-dashboard-api:dev -f apps/api/Dockerfile .

# web image (Dockerfile also expects the repo root as build context)
docker build -t dsc-fleet-dashboard-web:dev -f apps/web/Dockerfile .

# Verify they made it into the cluster's docker daemon.
docker images | Select-String 'dsc-fleet-dashboard'
```

The Deployments use `imagePullPolicy: Never` and the `:dev` tag — the cluster
will only run images already present in the minikube docker daemon. There is
no registry to push to.

## 5. Apply manifests from `.env`

```pwsh
.\k8s\Apply-FromEnv.ps1
```

What the script does:

1. Reads `.env`.
2. Validates `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
   `DATABASE_URL` are non-empty; warns on suspect values.
3. Creates the `dsc-fleet` namespace.
4. Generates and applies:
   - `Secret/postgres-credentials` from your `POSTGRES_*` + `DATABASE_URL`.
   - `ConfigMap/api-config` from non-secret tunables (with sane defaults
     filled in if a key is absent).
   - `Secret/azure-credentials` from your `AZURE_*` keys (empty allowed).
5. `kubectl apply -f` the static workload manifests:
   - `11-postgres.yaml` — StatefulSet + headless Service + 10 Gi PVC.
   - `21-api.yaml` — single-replica Deployment + ClusterIP Service.
   - `30-web.yaml` — Deployment + NodePort Service on `30080`.
6. Waits for each rollout (`postgres` → `api` → `web`).

Re-running the script is idempotent — every step uses `kubectl apply`. PVC
data is never touched.

Optional flags:

```pwsh
.\k8s\Apply-FromEnv.ps1 -Ingress              # also apply 40-ingress.yaml
.\k8s\Apply-FromEnv.ps1 -EnvFile path\to\.env # custom env file
.\k8s\Apply-FromEnv.ps1 -SkipWait             # don't wait for rollouts
.\k8s\Apply-FromEnv.ps1 -Namespace dsc-fleet  # override namespace name
```

## 6. Access the dashboard

```pwsh
# Easiest — opens your browser via a tunneled NodePort.
minikube service web -n dsc-fleet

# Direct port-forward to the api (for /healthz checks, openapi, etc.)
kubectl -n dsc-fleet port-forward svc/api 3000:3000
Invoke-RestMethod http://localhost:3000/healthz
```

`/healthz` should return:

- `db: ok` once Postgres is up and migrations have run.
- `azure: ok` if your SPN is valid; `azure: unconfigured` if `AZURE_TENANT_ID`
  was blank; `azure: error` with details if the SPN was rejected.

The api `Deployment` runs a single replica — see
[`../docs/architecture.md`](../docs/architecture.md) for why scaling
horizontally is unsafe today.

## 7. Updating after code or `.env` changes

```pwsh
# After editing source code:
& minikube -p minikube docker-env --shell powershell | Invoke-Expression
docker build -t dsc-fleet-dashboard-api:dev -f apps/api/Dockerfile .
kubectl -n dsc-fleet rollout restart deployment/api

# After editing .env (re-runs the script — only changed keys cause restarts):
.\k8s\Apply-FromEnv.ps1
kubectl -n dsc-fleet rollout restart deployment/api
```

`kubectl apply` on a Secret/ConfigMap doesn't restart pods that consume them,
so an explicit `rollout restart` is needed after Azure credential or DB URL
changes.

## 8. Persistent storage and backups

Postgres data lives on a `PersistentVolumeClaim` (`pgdata-postgres-0`, 10 Gi)
backed by minikube's `standard` (hostpath) `StorageClass`. The data is stored
on the minikube node filesystem under
`/var/lib/docker/volumes/minikube/_data/hostpath-provisioner/...` and
**survives**:

- `minikube stop` / `minikube start`
- host machine reboots
- pod restarts / api redeploys
- re-running `Apply-FromEnv.ps1`

It is **destroyed by**:

- `minikube delete`
- `kubectl delete pvc pgdata-postgres-0 -n dsc-fleet`

Take a backup before anything destructive:

```pwsh
kubectl -n dsc-fleet exec statefulset/postgres -- pg_dump -U dscfleet dscfleet > backup.sql
```

Restore:

```pwsh
Get-Content backup.sql | kubectl -n dsc-fleet exec -i statefulset/postgres -- psql -U dscfleet dscfleet
```

## 9. Common operations

```pwsh
# Tail api logs.
kubectl -n dsc-fleet logs -f deployment/api

# Tail postgres logs.
kubectl -n dsc-fleet logs -f statefulset/postgres

# Open a psql shell.
kubectl -n dsc-fleet exec -it statefulset/postgres -- psql -U dscfleet -d dscfleet

# Run prisma migrations manually (the api also runs them on start).
kubectl -n dsc-fleet exec deployment/api -- npx prisma migrate deploy

# Inspect rendered Secret/ConfigMap data the script produced.
kubectl -n dsc-fleet get secret postgres-credentials -o yaml
kubectl -n dsc-fleet get configmap api-config       -o yaml

# Check what the api is actually seeing in its environment.
kubectl -n dsc-fleet exec deployment/api -- env | Sort-Object
```

## 10. Tear down

```pwsh
# Soft — keep PVC, just stop pods.
kubectl -n dsc-fleet scale deployment/api --replicas=0
kubectl -n dsc-fleet scale deployment/web --replicas=0

# Medium — delete the namespace; PVC goes with it (data lost unless dumped).
kubectl delete namespace dsc-fleet --wait=false

# Hard — wipe the entire minikube node, all profiles, all data.
minikube delete
```

## What's in this directory

| File                | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `Apply-FromEnv.ps1` | The one-command deployer. Reads `../.env`, generates Secret/ConfigMap, applies all workloads, waits for rollouts. |
| `00-namespace.yaml` | `dsc-fleet` namespace (also generated by the script).                     |
| `11-postgres.yaml`  | Postgres StatefulSet + headless Service + 10 Gi PVC.                      |
| `21-api.yaml`       | api Deployment (single replica) + ClusterIP Service.                      |
| `30-web.yaml`       | web Deployment + NodePort Service on `30080`.                             |
| `40-ingress.yaml`   | (Optional) nginx Ingress for `dsc-fleet.local` — needs `minikube tunnel`. |

There is **no** static `postgres-secret.yaml` or `api-config.yaml` checked in
— their content depends on `.env` and is generated at apply-time by
`Apply-FromEnv.ps1`. This avoids a default-password footgun and a divergence
between docker-compose and k8s configuration.

## Troubleshooting

**`Apply-FromEnv.ps1` errors `Required env keys are empty`**
Open `.env`. The four keys it lists must all have non-empty values.

**`api` pod is `CrashLoopBackOff`, logs show `ECONNREFUSED postgres:5432`**
The postgres pod isn't ready yet, or `DATABASE_URL` doesn't point at
`@postgres:5432`. Check:

```pwsh
kubectl -n dsc-fleet get pods
kubectl -n dsc-fleet exec deployment/api -- env | Select-String DATABASE_URL
```

**`api` pod is `ErrImageNeverPull`**
You forgot to point your shell at the minikube docker daemon before
`docker build`. The image isn't visible to the cluster.

```pwsh
& minikube -p minikube docker-env --shell powershell | Invoke-Expression
docker build -t dsc-fleet-dashboard-api:dev -f apps/api/Dockerfile .
kubectl -n dsc-fleet rollout restart deployment/api
```

**`/healthz` shows `azure: error: AADSTS7000215`**
The client secret in `.env` is wrong or expired. Recreate the SPN secret:

```pwsh
az ad sp credential reset --id <appId> --years 1
# Then update AZURE_CLIENT_SECRET in .env and:
.\k8s\Apply-FromEnv.ps1
kubectl -n dsc-fleet rollout restart deployment/api
```

**`/healthz` shows `azure: error: AuthorizationFailed`**
The SPN exists and the secret is valid, but it doesn't have
`Microsoft.Compute/virtualMachines/runCommand/action` on the target
subscription/RG. Re-run the role assignment:

```pwsh
az role assignment create --assignee <appId> `
    --role 'Virtual Machine Contributor' `
    --scope "/subscriptions/<sub-guid>"
```

**Browser hangs on `minikube service web -n dsc-fleet`**
Some Windows + Hyper-V setups time out the tunnel. Use port-forward instead:

```pwsh
kubectl -n dsc-fleet port-forward svc/web 8080:80
# then open http://localhost:8080
```

**Pod stuck in `Pending` with `0/1 nodes are available: persistentvolumeclaim not bound`**
The default storage provisioner is disabled. Enable it:

```pwsh
minikube addons enable storage-provisioner
minikube addons enable default-storageclass
kubectl -n dsc-fleet delete pod postgres-0   # let it retry
```

**Need to expose the dashboard to a remote lab VM**
NodePort + minikube only serves the local browser. For a quick local-dev
exposure, see the cloudflared note in
[`../docs/getting-started.md`](../docs/getting-started.md#5-local-dev-only-expose-the-dashboard-to-a-remote-vm).
**Don't use that for real fleets** — host the api on stable infrastructure
with auth in front.
