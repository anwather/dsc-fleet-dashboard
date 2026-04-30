# Deploy Phase 3 — the three Container Apps (postgres, api, web).
#
# Reads / generates secrets, then calls main.bicep with deployApps=true.
# Secrets are persisted to .azure/secrets.local.json (git-ignored) so re-runs
# preserve the Postgres password — losing the password = losing the database.
#
# Usage:
#   ./azure/scripts/deploy-apps.ps1                    # what-if + deploy
#   ./azure/scripts/deploy-apps.ps1 -Tag 9bfb67c       # pin a specific image tag
#   ./azure/scripts/deploy-apps.ps1 -SkipWhatIf        # CI / re-deploy
#   ./azure/scripts/deploy-apps.ps1 -RotateRunAsKey    # generate a new key
#                                                       (will break existing creds)

[CmdletBinding()]
param(
    [string] $SubscriptionId,
    [string] $Location,
    [string] $RgName,
    [string] $LabRgName,
    [string] $NameSuffix,
    [string] $Tag            = 'latest',
    [string] $DeploymentName = ('apps-{0:yyyyMMdd-HHmmss}' -f (Get-Date)),
    [switch] $WhatIfOnly,
    [switch] $SkipWhatIf,
    [switch] $RotateRunAsKey
)

$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'

. (Join-Path $PSScriptRoot '_load-params.ps1')
$p = Get-DeploymentParams
if (-not $SubscriptionId) { $SubscriptionId = $p.subscriptionId }
if (-not $Location)       { $Location       = $p.location }
if (-not $RgName)         { $RgName         = $p.rgName }
if (-not $LabRgName)      { $LabRgName      = $p.labRgName }
if (-not $NameSuffix)     { $NameSuffix     = $p.nameSuffix }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bicep = Join-Path $repoRoot 'azure\bicep\main.bicep'
$secretsDir = Join-Path $repoRoot '.azure'
$secretsFile = Join-Path $secretsDir 'secrets.local.json'

if (-not (Test-Path $secretsDir)) { New-Item -ItemType Directory -Path $secretsDir | Out-Null }

# Make sure secrets file is git-ignored.
$gitignore = Join-Path $repoRoot '.gitignore'
if (Test-Path $gitignore) {
    $content = Get-Content $gitignore -Raw
    if ($content -notmatch '\.azure/secrets\.local\.json') {
        Add-Content $gitignore "`n# Local-only deployment secrets — never commit`n.azure/secrets.local.json`n"
        Write-Host "Added .azure/secrets.local.json to .gitignore" -ForegroundColor DarkGray
    }
}

function New-Base64Bytes([int]$NumBytes) {
    $b = New-Object byte[] $NumBytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    return [Convert]::ToBase64String($b)
}

# URL-safe base64 (RFC 4648 §5): replaces '+' with '-', '/' with '_', strips '='.
# Postgres accepts any printable ASCII for passwords, and these chars don't need
# percent-encoding in a URL user-info component. Used for pgPassword so the
# DATABASE_URL Prisma sees doesn't desync on '/' or '+'.
function New-UrlSafeBase64Bytes([int]$NumBytes) {
    $b = New-Object byte[] $NumBytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    return ([Convert]::ToBase64String($b)) -replace '\+','-' -replace '/','_' -replace '=',''
}

# Load or initialise secrets.
$secrets = @{}
if (Test-Path $secretsFile) {
    $secrets = Get-Content $secretsFile -Raw | ConvertFrom-Json -AsHashtable
}

if (-not $secrets.pgPassword) {
    # URL-safe alphabet only — base64 with '+' or '/' breaks DATABASE_URL parsing.
    $secrets.pgPassword = New-UrlSafeBase64Bytes 24
    Write-Host "Generated new Postgres password (URL-safe)." -ForegroundColor Yellow
}

if ($RotateRunAsKey -or -not $secrets.runAsMasterKey) {
    if ($RotateRunAsKey -and $secrets.runAsMasterKey) {
        Write-Host "ROTATING runAsMasterKey — existing encrypted credentials will become unreadable." -ForegroundColor Red
    }
    $secrets.runAsMasterKey = New-Base64Bytes 32
    Write-Host "Generated new runAsMasterKey (32 bytes base64)." -ForegroundColor Yellow
}

# Persist before deploy so we don't lose a freshly-generated password if the
# deploy fails part-way through.
$secrets | ConvertTo-Json | Set-Content -Path $secretsFile -Encoding UTF8
Write-Host "Secrets saved to $secretsFile (gitignored)." -ForegroundColor DarkGray

if (-not $secrets.entraTenantId -or -not $secrets.entraClientId) {
    throw "Missing entraTenantId / entraClientId in $secretsFile. Run azure/scripts/setup-entra.ps1 first."
}

az account set --subscription $SubscriptionId | Out-Null

# Pre-flight: confirm both images exist in ACR with the requested tag,
# otherwise the Bicep deploy will fail ~5 minutes in with a cryptic
# 'MANIFEST_UNKNOWN' from the Container App revision controller.
$registryName = ('dscfleet{0}acr' -f $NameSuffix).ToLowerInvariant()
Write-Host "`nChecking images in $registryName..." -ForegroundColor Cyan
$missing = @()
foreach ($repo in @('dsc-fleet/api','dsc-fleet/web')) {
    $tags = az acr repository show-tags --name $registryName --repository $repo -o tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $tags) {
        $missing += "$repo (repository not found)"
        continue
    }
    if ($tags -notcontains $Tag) {
        $missing += "${repo}:$Tag (tag not found; available: $((@($tags) | Select-Object -First 5) -join ', '))"
    } else {
        Write-Host ("  OK  {0}:{1}" -f $repo, $Tag) -ForegroundColor DarkGray
    }
}
if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "Required images are missing from ACR:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Build & push them first:" -ForegroundColor Yellow
    if ($Tag -eq 'latest') {
        Write-Host "  ./azure/scripts/build-and-push.ps1" -ForegroundColor White
    } else {
        Write-Host "  ./azure/scripts/build-and-push.ps1 -Tag $Tag" -ForegroundColor White
    }
    throw "Aborting deploy-apps: images not in ACR."
}

$paramArgs = @(
    "location=$Location",
    "rgName=$RgName",
    "labRgName=$LabRgName",
    "nameSuffix=$NameSuffix",
    "deployApps=true",
    "imageTag=$Tag",
    "pgPassword=$($secrets.pgPassword)",
    "runAsMasterKey=$($secrets.runAsMasterKey)",
    "entraTenantId=$($secrets.entraTenantId)",
    "entraApiClientId=$($secrets.entraClientId)"
)

Write-Host "Subscription:  $SubscriptionId" -ForegroundColor DarkGray
Write-Host "Location:      $Location"       -ForegroundColor DarkGray
Write-Host "Resource grp:  $RgName"         -ForegroundColor DarkGray
Write-Host "Lab rg:        $LabRgName"      -ForegroundColor DarkGray
Write-Host "Name suffix:   $NameSuffix      <- must match the value used by deploy.ps1" -ForegroundColor DarkGray
Write-Host "Image tag:     $Tag"            -ForegroundColor DarkGray

if (-not $SkipWhatIf) {
    Write-Host "`nRunning what-if..." -ForegroundColor Cyan
    az deployment sub what-if `
        --name $DeploymentName `
        --location $Location `
        --template-file $bicep `
        --parameters @paramArgs
    if ($LASTEXITCODE -ne 0) { throw "what-if failed (exit $LASTEXITCODE)" }
}

if ($WhatIfOnly) {
    Write-Host "`n-WhatIfOnly set; exiting." -ForegroundColor Yellow
    return
}

if (-not $SkipWhatIf) {
    $confirm = Read-Host "`nProceed with deployment? [y/N]"
    if ($confirm -notmatch '^(y|yes)$') { Write-Host "Aborted." -ForegroundColor Yellow; return }
}

Write-Host "`nDeploying ($DeploymentName)..." -ForegroundColor Cyan
$deployJson = az deployment sub create `
    --name $DeploymentName `
    --location $Location `
    --template-file $bicep `
    --parameters @paramArgs `
    --output json
if ($LASTEXITCODE -ne 0) { throw "deployment failed (exit $LASTEXITCODE)" }

$out = ($deployJson | ConvertFrom-Json).properties.outputs
Write-Host "`n=== Apps deployed ===" -ForegroundColor Green
Write-Host ("API:  https://{0}" -f $out.apiFqdn.value)
Write-Host ("Web:  https://{0}" -f $out.webFqdn.value)
Write-Host "`nNext: open the web URL, add a server, and verify it heartbeats." -ForegroundColor Cyan
