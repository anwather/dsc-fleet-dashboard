#!/usr/bin/env bash
# One-shot deploy of dsc-fleet-dashboard to a local minikube cluster.
#
# See scripts/deploy-minikube.ps1 for the full description — this is the
# Linux/WSL equivalent. Same flags:
#   --env-file PATH    (default ../.env)
#   --namespace NAME   (default dsc-fleet)
#   --ingress
#   --rebuild-only
#   --apply-only
#   --no-wait
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
NAMESPACE="dsc-fleet"
INGRESS=false
REBUILD_ONLY=false
APPLY_ONLY=false
NO_WAIT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)     ENV_FILE="$2"; shift 2 ;;
    --namespace)    NAMESPACE="$2"; shift 2 ;;
    --ingress)      INGRESS=true; shift ;;
    --rebuild-only) REBUILD_ONLY=true; shift ;;
    --apply-only)   APPLY_ONLY=true; shift ;;
    --no-wait)      NO_WAIT=true; shift ;;
    -h|--help)      grep -E '^# ' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

need() { command -v "$1" >/dev/null || { echo "Missing tool: $1" >&2; exit 1; }; }
need docker; need minikube; need kubectl

if [[ "$(minikube status --format '{{.Host}}' 2>/dev/null || true)" != "Running" ]]; then
  echo "minikube is not running. Start it with: minikube start" >&2
  exit 1
fi

if ! $APPLY_ONLY; then
  echo "[deploy] Switching shell to minikube docker daemon..."
  eval "$(minikube -p minikube docker-env)"
  echo "[deploy] Building dsc-fleet-dashboard-api:dev..."
  docker build -t dsc-fleet-dashboard-api:dev -f "$REPO_ROOT/apps/api/Dockerfile" "$REPO_ROOT"
  echo "[deploy] Building dsc-fleet-dashboard-web:dev..."
  docker build -t dsc-fleet-dashboard-web:dev -f "$REPO_ROOT/apps/web/Dockerfile" "$REPO_ROOT"
fi

if ! $REBUILD_ONLY; then
  echo "[deploy] Applying manifests via k8s/Apply-FromEnv.ps1..."
  PWSH_ARGS=( -EnvFile "$ENV_FILE" -Namespace "$NAMESPACE" )
  $INGRESS && PWSH_ARGS+=( -Ingress )
  $NO_WAIT && PWSH_ARGS+=( -SkipWait )
  pwsh -NoProfile -File "$REPO_ROOT/k8s/Apply-FromEnv.ps1" "${PWSH_ARGS[@]}"
fi

if ! $APPLY_ONLY; then
  echo "[deploy] Restarting deployments..."
  kubectl -n "$NAMESPACE" rollout restart deploy/api
  kubectl -n "$NAMESPACE" rollout restart deploy/web
fi

if ! $NO_WAIT; then
  echo "[deploy] Waiting for rollouts..."
  kubectl -n "$NAMESPACE" rollout status deploy/api --timeout=180s
  kubectl -n "$NAMESPACE" rollout status deploy/web --timeout=180s
  kubectl -n "$NAMESPACE" wait --for=condition=ready pod -l app=postgres --timeout=180s >/dev/null
fi

echo
echo "[deploy] Done. Web URL:"
NODE_IP="$(minikube ip 2>/dev/null || true)"
NODE_PORT="$(kubectl -n "$NAMESPACE" get svc web -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true)"
if [[ -n "$NODE_IP" && -n "$NODE_PORT" ]]; then
  echo "  http://${NODE_IP}:${NODE_PORT}"
else
  echo "  Run: minikube service web -n $NAMESPACE"
fi
