<#
.SYNOPSIS
    Deploy the dsc-fleet-dashboard stack to a local minikube cluster, sourcing
    all configuration from the repo-root .env file.

.DESCRIPTION
    Reads .env, then for each kubernetes object that needs configuration:
      * Generates `postgres-credentials` Secret from POSTGRES_USER /
        POSTGRES_PASSWORD / POSTGRES_DB / DATABASE_URL.
      * Generates `api-config` ConfigMap from API_PORT, LOG_LEVEL, NODE_ENV,
        AGENT_POLL_DEFAULT_SECONDS, OFFLINE_MULTIPLIER,
        DEFAULT_ASSIGNMENT_INTERVAL_MINUTES, AZURE_RUNCOMMAND_TIMEOUT_MINUTES,
        REMOVAL_ACK_TIMEOUT_MINUTES, DSC_CONFIG_SCHEMA_URL.
      * Generates `azure-credentials` Secret from AZURE_TENANT_ID /
        AZURE_CLIENT_ID / AZURE_CLIENT_SECRET (empty values are allowed —
        the api will boot but Azure operations stay disabled).

    Then applies the static workload manifests (postgres, api, web, optionally
    ingress) from this directory.

    Re-running the script is safe — every kubectl call uses `apply` so all
    objects are created or updated in place. Postgres data on the PVC is not
    touched by re-runs.

.PARAMETER EnvFile
    Path to the .env file. Defaults to ../.env relative to this script.

.PARAMETER Namespace
    Target namespace. Defaults to dsc-fleet.

.PARAMETER Ingress
    Also apply 40-ingress.yaml. Requires `minikube tunnel` running in another
    elevated shell and `minikube addons enable ingress` already done.

.PARAMETER SkipWait
    Skip the rollout-status waits at the end (useful in CI / smoke tests).

.EXAMPLE
    PS> .\Apply-FromEnv.ps1
    Reads ..\.env, applies everything, waits for rollouts.

.EXAMPLE
    PS> .\Apply-FromEnv.ps1 -EnvFile C:\my\custom.env -Ingress
#>
[CmdletBinding()]
param(
    [string] $EnvFile   = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env'),
    [string] $Namespace = 'dsc-fleet',
    [switch] $Ingress,
    [switch] $SkipWait
)

$ErrorActionPreference = 'Stop'

function Read-DotEnv {
    param([Parameter(Mandatory)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Env file not found: $Path. Copy .env.example to .env and fill in values first."
    }
    $map = [ordered]@{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trim = $line.Trim()
        if (-not $trim -or $trim.StartsWith('#')) { continue }
        $eq = $trim.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $trim.Substring(0, $eq).Trim()
        $val = $trim.Substring($eq + 1).Trim()
        # Strip optional surrounding quotes.
        if ($val.Length -ge 2 -and (
                ($val.StartsWith('"') -and $val.EndsWith('"')) -or
                ($val.StartsWith("'") -and $val.EndsWith("'"))
            )) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        $map[$key] = $val
    }
    $map
}

function Require-Tool {
    param([Parameter(Mandatory)] [string] $Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name not found on PATH."
    }
}

function Invoke-KubectlApplyStdin {
    param(
        [Parameter(Mandatory)] [string] $Yaml,
        [Parameter(Mandatory)] [string] $Description
    )
    Write-Host "==> $Description" -ForegroundColor Cyan
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        Set-Content -LiteralPath $tmp -Value $Yaml -Encoding UTF8
        & kubectl apply -f $tmp
        if ($LASTEXITCODE -ne 0) { throw "kubectl apply failed for $Description (exit $LASTEXITCODE)." }
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

function ConvertTo-Base64 {
    param([string] $Text)
    if ($null -eq $Text) { $Text = '' }
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Text))
}

# --- 0. Sanity ---------------------------------------------------------------

Require-Tool -Name 'kubectl'

Write-Host "Reading env from $EnvFile" -ForegroundColor Yellow
$env = Read-DotEnv -Path $EnvFile

$required = @('POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'DATABASE_URL')
$missing  = $required | Where-Object { -not $env[$_] }
if ($missing) {
    throw "Required env keys are empty in ${EnvFile}: $($missing -join ', ')"
}

# Sanity: DATABASE_URL host should match the in-cluster Service name (`postgres`),
# not `localhost`. The same .env is used by docker-compose where `postgres` is
# the compose service name, so this should already be correct.
if ($env['DATABASE_URL'] -notmatch '@postgres[:/]') {
    Write-Warning "DATABASE_URL does not look like it points at the in-cluster 'postgres' Service. The api pod will likely fail to connect. Got: $($env['DATABASE_URL'])"
}

# --- 1. Namespace ------------------------------------------------------------

$nsManifest = @"
apiVersion: v1
kind: Namespace
metadata:
  name: $Namespace
"@
Invoke-KubectlApplyStdin -Yaml $nsManifest -Description "namespace/$Namespace"

# --- 2. postgres-credentials Secret ------------------------------------------

$pgUserB64 = ConvertTo-Base64 $env['POSTGRES_USER']
$pgPassB64 = ConvertTo-Base64 $env['POSTGRES_PASSWORD']
$pgDbB64   = ConvertTo-Base64 $env['POSTGRES_DB']
$pgUrlB64  = ConvertTo-Base64 $env['DATABASE_URL']

$pgSecret = @"
apiVersion: v1
kind: Secret
metadata:
  name: postgres-credentials
  namespace: $Namespace
type: Opaque
data:
  POSTGRES_USER: $pgUserB64
  POSTGRES_PASSWORD: $pgPassB64
  POSTGRES_DB: $pgDbB64
  DATABASE_URL: $pgUrlB64
"@
Invoke-KubectlApplyStdin -Yaml $pgSecret -Description 'secret/postgres-credentials'

# --- 3. api-config ConfigMap -------------------------------------------------

$cfgKeys = @(
    'API_PORT', 'LOG_LEVEL', 'NODE_ENV',
    'AGENT_POLL_DEFAULT_SECONDS', 'OFFLINE_MULTIPLIER',
    'DEFAULT_ASSIGNMENT_INTERVAL_MINUTES',
    'AZURE_RUNCOMMAND_TIMEOUT_MINUTES',
    'REMOVAL_ACK_TIMEOUT_MINUTES',
    'PUBLIC_BASE_URL',
    'DSC_CONFIG_SCHEMA_URL'
)

$cfgDefaults = @{
    API_PORT                            = '3000'
    LOG_LEVEL                           = 'info'
    NODE_ENV                            = 'production'
    AGENT_POLL_DEFAULT_SECONDS          = '60'
    OFFLINE_MULTIPLIER                  = '3'
    DEFAULT_ASSIGNMENT_INTERVAL_MINUTES = '15'
    AZURE_RUNCOMMAND_TIMEOUT_MINUTES    = '30'
    REMOVAL_ACK_TIMEOUT_MINUTES         = '60'
    DSC_CONFIG_SCHEMA_URL               = 'https://aka.ms/dsc/schemas/v3/bundled/config/document.json'
}

$dataLines = foreach ($key in $cfgKeys) {
    $value = if ($env[$key]) { $env[$key] } else { $cfgDefaults[$key] }
    # Skip keys with no value and no default — emitting empty strings into
    # the ConfigMap would break zod validators for typed URL/number fields
    # (e.g. PUBLIC_BASE_URL with .url()).
    if (-not $value) { continue }
    # ConfigMap values must be strings; quote to avoid YAML number/bool coercion.
    "  ${key}: ""$value"""
}

$cfgMap = @"
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
  namespace: $Namespace
data:
$($dataLines -join "`n")
"@
Invoke-KubectlApplyStdin -Yaml $cfgMap -Description 'configmap/api-config'

# --- 4. azure-credentials Secret (may be empty) ------------------------------

$azTenantB64 = ConvertTo-Base64 $env['AZURE_TENANT_ID']
$azClientB64 = ConvertTo-Base64 $env['AZURE_CLIENT_ID']
$azSecretB64 = ConvertTo-Base64 $env['AZURE_CLIENT_SECRET']

$azSecret = @"
apiVersion: v1
kind: Secret
metadata:
  name: azure-credentials
  namespace: $Namespace
type: Opaque
data:
  AZURE_TENANT_ID: $azTenantB64
  AZURE_CLIENT_ID: $azClientB64
  AZURE_CLIENT_SECRET: $azSecretB64
"@
Invoke-KubectlApplyStdin -Yaml $azSecret -Description 'secret/azure-credentials'

if (-not $env['AZURE_TENANT_ID']) {
    Write-Warning "AZURE_TENANT_ID is empty — Azure provisioning endpoints will return clear errors. Fine for a UI-only walkthrough."
}

# --- 5. Workloads ------------------------------------------------------------

$workloads = @(
    @{ File = '11-postgres.yaml'; Desc = 'postgres StatefulSet + Service + PVC' },
    @{ File = '21-api.yaml';      Desc = 'api Deployment + Service' },
    @{ File = '30-web.yaml';      Desc = 'web Deployment + NodePort' }
)

foreach ($w in $workloads) {
    $path = Join-Path $PSScriptRoot $w.File
    Write-Host "==> $($w.Desc)" -ForegroundColor Cyan
    & kubectl apply -f $path
    if ($LASTEXITCODE -ne 0) { throw "kubectl apply failed for $($w.File)." }
}

if ($Ingress) {
    $path = Join-Path $PSScriptRoot '40-ingress.yaml'
    Write-Host '==> ingress' -ForegroundColor Cyan
    & kubectl apply -f $path
    if ($LASTEXITCODE -ne 0) { throw 'kubectl apply failed for 40-ingress.yaml.' }
}

# --- 6. Wait for rollouts ----------------------------------------------------

if (-not $SkipWait) {
    Write-Host '==> waiting for rollouts (postgres → api → web)' -ForegroundColor Cyan
    & kubectl -n $Namespace rollout status statefulset/postgres --timeout=180s
    & kubectl -n $Namespace rollout status deployment/api       --timeout=180s
    & kubectl -n $Namespace rollout status deployment/web       --timeout=120s
}

Write-Host ''
Write-Host 'Done. Open the dashboard with:' -ForegroundColor Green
Write-Host "  minikube service web -n $Namespace" -ForegroundColor Green
