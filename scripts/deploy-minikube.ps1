<#
.SYNOPSIS
    One-shot deploy of dsc-fleet-dashboard to a local minikube cluster.

.DESCRIPTION
    Idempotent end-to-end deploy:
      1. Verifies prereqs (docker, minikube, kubectl) and that minikube is running.
      2. Switches the current shell to the minikube docker daemon so locally
         built images are visible to the cluster without a registry push.
      3. Builds the api and web images (tag :dev) with the repo root as the
         Docker build context.
      4. Runs k8s\Apply-FromEnv.ps1 to render Secrets/ConfigMaps from .env and
         apply all manifests.
      5. Restarts the api and web deployments so they pick up the freshly
         built images.
      6. Waits for rollouts and prints the web service URL.

    Re-run any time after code changes — only the steps you need run again.

.PARAMETER EnvFile
    Path to .env. Defaults to ..\.env relative to this script.

.PARAMETER Namespace
    Kubernetes namespace. Defaults to dsc-fleet.

.PARAMETER Ingress
    Also apply k8s\40-ingress.yaml via Apply-FromEnv.ps1.

.PARAMETER RebuildOnly
    Build images and restart deployments. Skip Apply-FromEnv.ps1.

.PARAMETER ApplyOnly
    Apply manifests only. Skip docker build and rollout restart.

.PARAMETER NoWait
    Skip the rollout-status waits at the end.

.EXAMPLE
    PS> .\scripts\deploy-minikube.ps1
    Full deploy from scratch.

.EXAMPLE
    PS> .\scripts\deploy-minikube.ps1 -RebuildOnly
    After editing src — rebuild images and roll the deployments.
#>
[CmdletBinding()]
param(
    [string] $EnvFile   = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env'),
    [string] $Namespace = 'dsc-fleet',
    [switch] $Ingress,
    [switch] $RebuildOnly,
    [switch] $ApplyOnly,
    [switch] $NoWait
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path $PSScriptRoot -Parent

function Test-Tool {
    param([string] $Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required tool '$Name' is not on PATH."
    }
}

function Invoke-DockerEnv {
    Write-Host "[deploy] Switching shell to minikube docker daemon..." -ForegroundColor Cyan
    & minikube -p minikube docker-env --shell powershell | Out-String | Invoke-Expression
}

function Build-Image {
    param([string] $Tag, [string] $Dockerfile)
    Write-Host "[deploy] Building $Tag..." -ForegroundColor Cyan
    & docker build -t $Tag -f $Dockerfile $RepoRoot
    if ($LASTEXITCODE -ne 0) { throw "docker build failed for $Tag" }
}

function Restart-Deployment {
    param([string] $Name)
    Write-Host "[deploy] Restarting deploy/$Name..." -ForegroundColor Cyan
    & kubectl -n $Namespace rollout restart "deploy/$Name" | Out-Null
}

# 1. Prereqs ----------------------------------------------------------------
Test-Tool docker
Test-Tool minikube
Test-Tool kubectl

$mkStatus = (& minikube status --format '{{.Host}}' 2>$null)
if ($LASTEXITCODE -ne 0 -or $mkStatus -ne 'Running') {
    throw "minikube is not running. Start it with: minikube start"
}

# 2/3. Build images ---------------------------------------------------------
if (-not $ApplyOnly) {
    Invoke-DockerEnv
    Build-Image -Tag 'dsc-fleet-dashboard-api:dev' -Dockerfile (Join-Path $RepoRoot 'apps\api\Dockerfile')
    Build-Image -Tag 'dsc-fleet-dashboard-web:dev' -Dockerfile (Join-Path $RepoRoot 'apps\web\Dockerfile')
}

# 4. Apply manifests --------------------------------------------------------
if (-not $RebuildOnly) {
    Write-Host "[deploy] Applying manifests via k8s\Apply-FromEnv.ps1..." -ForegroundColor Cyan
    $applyArgs = @{ EnvFile = $EnvFile; Namespace = $Namespace }
    if ($Ingress) { $applyArgs.Ingress  = $true }
    if ($NoWait)  { $applyArgs.SkipWait = $true }
    & (Join-Path $RepoRoot 'k8s\Apply-FromEnv.ps1') @applyArgs
}

# 5. Roll deployments so freshly built images are picked up. ----------------
if (-not $ApplyOnly) {
    Restart-Deployment api
    Restart-Deployment web
}

# 6. Wait + print URL -------------------------------------------------------
if (-not $NoWait) {
    Write-Host "[deploy] Waiting for rollouts..." -ForegroundColor Cyan
    & kubectl -n $Namespace rollout status deploy/api --timeout=180s
    & kubectl -n $Namespace rollout status deploy/web --timeout=180s
    & kubectl -n $Namespace wait --for=condition=ready pod -l app=postgres --timeout=180s | Out-Null
}

Write-Host ""
Write-Host "[deploy] Done." -ForegroundColor Green
$nodeIp = (& minikube ip).Trim()
$nodePort = (& kubectl -n $Namespace get svc web -o jsonpath='{.spec.ports[0].nodePort}')
Write-Host "  Service NodePort:  http://${nodeIp}:${nodePort}"
Write-Host "  On Windows/macOS with the docker driver the NodePort isn't reachable"
Write-Host "  from the host directly. Open the dashboard with the minikube tunnel:"
Write-Host "    minikube service web -n $Namespace" -ForegroundColor Yellow
