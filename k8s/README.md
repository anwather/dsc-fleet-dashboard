# Kubernetes (minikube) deployment

These manifests run the dashboard on a local minikube cluster with persistent
storage for Postgres that survives `minikube stop` / `minikube start` and host
reboots.

## What's in here

| File | Purpose |
| --- | --- |
| `00-namespace.yaml` | `dsc-fleet` namespace |
| `10-postgres-secret.yaml` | DB credentials + `DATABASE_URL` for the api |
| `11-postgres.yaml` | Postgres `StatefulSet` + headless `Service` + 10 Gi `PVC` |
| `20-api-config.yaml` | `ConfigMap` with non-secret env + `azure-credentials` `Secret` |
| `21-api.yaml` | api `Deployment` (single replica) + ClusterIP `Service` |
| `30-web.yaml` | web `Deployment` + `NodePort` `Service` on `30080` |
| `40-ingress.yaml` | (optional) nginx `Ingress` for `dsc-fleet.local` |

## One-time prep

```pwsh
# 1. Start minikube with enough resources.
minikube start --cpus=4 --memory=6g --disk-size=20g

# 2. (Optional) enable ingress + metrics.
minikube addons enable ingress
minikube addons enable storage-provisioner   # default-on, but verify

# 3. Point your local docker CLI at the minikube docker daemon so built
#    images are visible to the cluster without pushing to a registry.
#    Run this in EVERY shell you use to build images.
& minikube -p minikube docker-env --shell powershell | Invoke-Expression
```

## Build images into the cluster

```pwsh
cd C:\Source\dsc-fleet-dashboard

# api
docker build -t dsc-fleet-dashboard-api:dev -f apps/api/Dockerfile .

# web
docker build -t dsc-fleet-dashboard-web:dev -f apps/web/Dockerfile apps/web
```

## Apply manifests

```pwsh
# Edit secrets first if you want to change the DB password or wire Azure auth.
notepad k8s\10-postgres-secret.yaml
notepad k8s\20-api-config.yaml

kubectl apply -f k8s\00-namespace.yaml
kubectl apply -f k8s\10-postgres-secret.yaml
kubectl apply -f k8s\11-postgres.yaml
kubectl rollout status statefulset/postgres -n dsc-fleet
kubectl apply -f k8s\20-api-config.yaml
kubectl apply -f k8s\21-api.yaml
kubectl rollout status deployment/api -n dsc-fleet
kubectl apply -f k8s\30-web.yaml
kubectl rollout status deployment/web -n dsc-fleet

# Optional ingress (run `minikube tunnel` in a separate elevated shell first).
kubectl apply -f k8s\40-ingress.yaml
```

## Access the dashboard

```pwsh
# NodePort (simplest):
minikube service web -n dsc-fleet
# This opens the browser on http://127.0.0.1:<random> tunneled to NodePort 30080.

# Direct API for debugging:
kubectl -n dsc-fleet port-forward svc/api 3000:3000
curl http://localhost:3000/healthz
```

## Persistent storage

Postgres data lives on a `PersistentVolumeClaim` (`pgdata-postgres-0`,
10 Gi) backed by minikube's `standard` (hostpath) `StorageClass`. The data
is stored on the minikube node filesystem under
`/var/lib/docker/volumes/minikube/_data/hostpath-provisioner/...` and
**survives**:

- `minikube stop` / `minikube start`
- host machine reboots
- pod restarts / api redeploys

It is **destroyed by**:

- `minikube delete`
- manual `kubectl delete pvc pgdata-postgres-0 -n dsc-fleet`

To back up before a destructive operation:

```pwsh
kubectl -n dsc-fleet exec statefulset/postgres -- pg_dump -U dscfleet dscfleet > backup.sql
```

To restore:

```pwsh
Get-Content backup.sql | kubectl -n dsc-fleet exec -i statefulset/postgres -- psql -U dscfleet dscfleet
```

## Common operations

```pwsh
# Tail api logs.
kubectl -n dsc-fleet logs -f deployment/api

# Roll the api after a code change.
docker build -t dsc-fleet-dashboard-api:dev -f apps/api/Dockerfile .
kubectl -n dsc-fleet rollout restart deployment/api

# Roll the web after a code change.
docker build -t dsc-fleet-dashboard-web:dev -f apps/web/Dockerfile apps/web
kubectl -n dsc-fleet rollout restart deployment/web

# Open a psql shell.
kubectl -n dsc-fleet exec -it statefulset/postgres -- psql -U dscfleet -d dscfleet

# Run prisma migrations manually (the api also runs them on start).
kubectl -n dsc-fleet exec deployment/api -- npx prisma migrate deploy
```

## Tear down (keeps data)

```pwsh
kubectl delete namespace dsc-fleet --wait=false
# The PVC is namespaced and goes with it. To preserve data across namespace
# rebuilds, take a pg_dump first and re-import after re-applying.
```

## Tear down (destroy data)

```pwsh
minikube delete
```

## Notes

- **api replicas stay at 1** — the in-process scheduler in `apps/api/src/services/scheduler.ts` assumes single-writer. Do not scale horizontally without adding leader election.
- **Agents on Windows Servers** must reach the api on a routable address.
  NodePort + minikube only works for browser access from the same host. For
  real lab use, expose via `minikube tunnel` + ingress with a hostname, or
  switch to a real cluster.
- **Image pull policy** is `Never` because we load images directly into the
  minikube docker daemon. If you push to a registry, change this and add
  `imagePullSecrets`.
- **Resource limits** are conservative. Raise the `api` memory limit if you
  see OOMKills during large config parses.
