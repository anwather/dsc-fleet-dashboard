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
    [string] $SubscriptionId = '01e2f327-74ac-451e-8ad9-1f923a06d634',
    [string] $RegistryName   = 'dscfleetdscacr',
    [ValidateSet('all', 'api', 'web')]
    [string] $Only = 'all',
    [string] $Tag  = ''
)

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
    Write-Host "Repo root:     $repoRoot" -ForegroundColor DarkGray
    Write-Host "Subscription:  $SubscriptionId" -ForegroundColor DarkGray
    Write-Host "Registry:      $RegistryName" -ForegroundColor DarkGray
    Write-Host "Tag:           $Tag" -ForegroundColor DarkGray
    Write-Host "Targets:       $Only" -ForegroundColor DarkGray

    az account set --subscription $SubscriptionId | Out-Null

    function Build-Image {
        param([string] $Image, [string] $Dockerfile)
        $ref = "$Image`:$Tag"
        $latest = "$Image`:latest"
        Write-Host "`n=== az acr build $ref (+ $latest) ===" -ForegroundColor Cyan
        # Two -t flags = both tags pushed in a single build.
        az acr build `
            --registry $RegistryName `
            --image $ref `
            --image $latest `
            --file $Dockerfile `
            .
        $azExit = $LASTEXITCODE
        if ($azExit -ne 0) {
            # `az acr build` streams logs and may exit non-zero because of
            # a Unicode-encoding crash in the Python log streamer even when
            # the actual ACR run succeeded. Poll the run status until terminal.
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
    if ($Only -in @('all','web')) { Build-Image -Image 'dsc-fleet/web' -Dockerfile 'apps/web/Dockerfile' }

    Write-Host "`n=== Repository contents ===" -ForegroundColor Green
    az acr repository list --name $RegistryName -o tsv | Sort-Object | ForEach-Object {
        $tags = az acr repository show-tags --name $RegistryName --repository $_ --orderby time_desc --top 5 -o tsv
        "{0,-25} {1}" -f $_, ($tags -join ', ')
    }
}
finally {
    Pop-Location
}
