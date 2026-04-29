# Build & push the API and Web images to ACR using `az acr build`
# (server-side build — no local Docker required).
#
# Usage:
#   ./azure/scripts/build-and-push.ps1                     # both images, tag = git short sha
#   ./azure/scripts/build-and-push.ps1 -Tag v1             # explicit tag
#   ./azure/scripts/build-and-push.ps1 -Only api           # api only
#   ./azure/scripts/build-and-push.ps1 -Only web -Tag v1   # web only
#
# Requires: `az login` against subscription 01e2f327-… and Phase 1 deployed
# (the ACR `dscfleetdscacr` must exist).

[CmdletBinding()]
param(
    [string] $SubscriptionId,
    [string] $RegistryName,
    [ValidateSet('all', 'api', 'web')]
    [string] $Only = 'all',
    [string] $Tag  = '',
    # Entra build args required by the web image. If omitted, will be read
    # from .azure/secrets.local.json (populated by setup-entra.ps1).
    [string] $EntraTenantId = '',
    [string] $EntraClientId = ''
)

. (Join-Path $PSScriptRoot '_load-params.ps1')
$p = Get-DeploymentParams
if (-not $SubscriptionId) { $SubscriptionId = $p.subscriptionId }
# ACR name pattern: matches azure/bicep/main.bicep -> 'dscfleet${nameSuffix}acr'
if (-not $RegistryName)   { $RegistryName   = ('dscfleet{0}acr' -f $p.nameSuffix).ToLowerInvariant() }

$ErrorActionPreference = 'Stop'
# `az acr build` streams build logs to stdout. The Azure CLI uses cp1252 on
# Windows by default and crashes on Unicode chars (Prisma uses ✔). Force UTF-8
# for both Python (Azure CLI) and PowerShell so streaming doesn't fail and
# falsely flag a successful build as failed.
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $repoRoot
try {
    if (-not $Tag) {
        $Tag = (& git rev-parse --short HEAD 2>$null)
        if ($LASTEXITCODE -ne 0 -or -not $Tag) { $Tag = 'latest' }
    }

    # Resolve Entra build args from secrets.local.json if not passed.
    if ($Only -in @('all','web')) {
        if (-not $EntraTenantId -or -not $EntraClientId) {
            $secretsFile = Join-Path $repoRoot '.azure\secrets.local.json'
            if (Test-Path $secretsFile) {
                $s = Get-Content $secretsFile -Raw | ConvertFrom-Json
                if (-not $EntraTenantId) { $EntraTenantId = $s.entraTenantId }
                if (-not $EntraClientId) { $EntraClientId = $s.entraClientId }
            }
        }
        if (-not $EntraTenantId -or -not $EntraClientId) {
            throw "Web build requires -EntraTenantId and -EntraClientId (or run azure/scripts/setup-entra.ps1 to populate secrets.local.json)."
        }
    }

    Write-Host "Repo root:     $repoRoot" -ForegroundColor DarkGray
    Write-Host "Subscription:  $SubscriptionId" -ForegroundColor DarkGray
    Write-Host "Registry:      $RegistryName" -ForegroundColor DarkGray
    Write-Host "Tag:           $Tag" -ForegroundColor DarkGray
    Write-Host "Targets:       $Only" -ForegroundColor DarkGray
    if ($Only -in @('all','web')) {
        Write-Host ("Entra tenant:  {0}" -f $EntraTenantId) -ForegroundColor DarkGray
        Write-Host ("Entra client:  {0}" -f $EntraClientId) -ForegroundColor DarkGray
    }

    az account set --subscription $SubscriptionId | Out-Null

    function Build-Image {
        param(
            [string] $Image,
            [string] $Dockerfile,
            [string[]] $BuildArgs = @()
        )
        $ref = "$Image`:$Tag"
        $latest = "$Image`:latest"
        Write-Host "`n=== az acr build $ref (+ $latest) ===" -ForegroundColor Cyan
        $cmd = @(
            'acr','build',
            '--registry', $RegistryName,
            '--image', $ref,
            '--image', $latest,
            '--file', $Dockerfile
        )
        foreach ($ba in $BuildArgs) { $cmd += @('--build-arg', $ba) }
        $cmd += '.'
        & az @cmd
        $azExit = $LASTEXITCODE
        if ($azExit -ne 0) {
            $runId = az acr task list-runs --registry $RegistryName --top 1 --query '[0].runId' -o tsv
            Write-Host "  (az CLI exited $azExit; polling ACR run $runId)" -ForegroundColor DarkGray
            do {
                Start-Sleep -Seconds 10
                $status = az acr task list-runs --registry $RegistryName --top 5 --query "[?runId=='$runId'].status | [0]" -o tsv
                Write-Host "    $(Get-Date -Format HH:mm:ss) status=$status" -ForegroundColor DarkGray
            } while ($status -in @('Queued','Running','Started'))
            if ($status -eq 'Succeeded') {
                Write-Host "  (ACR run actually Succeeded — proceeding)" -ForegroundColor Yellow
            } else {
                throw "build failed: $Image (run $runId final status: $status)"
            }
        }
    }

    if ($Only -in @('all','api')) { Build-Image -Image 'dsc-fleet/api' -Dockerfile 'apps/api/Dockerfile' }
    if ($Only -in @('all','web')) {
        Build-Image -Image 'dsc-fleet/web' -Dockerfile 'apps/web/Dockerfile' -BuildArgs @(
            "VITE_ENTRA_TENANT_ID=$EntraTenantId",
            "VITE_ENTRA_CLIENT_ID=$EntraClientId"
        )
    }

    Write-Host "`n=== Repository contents ===" -ForegroundColor Green
    az acr repository list --name $RegistryName -o tsv | Sort-Object | ForEach-Object {
        $tags = az acr repository show-tags --name $RegistryName --repository $_ --orderby time_desc --top 5 -o tsv
        "{0,-25} {1}" -f $_, ($tags -join ', ')
    }
}
finally {
    Pop-Location
}
