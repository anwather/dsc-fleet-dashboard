# Deploy Phase 1 infrastructure for dsc-fleet-dashboard.
#
# Usage:
#   ./azure/scripts/deploy.ps1                # what-if + interactive deploy
#   ./azure/scripts/deploy.ps1 -WhatIfOnly    # show changes only, no deploy
#   ./azure/scripts/deploy.ps1 -SkipWhatIf    # deploy directly (CI use)
#   ./azure/scripts/deploy.ps1 -SkipLabRbac   # skip cross-RG role assignment
#                                             # (use if you lack Owner on dsc-v3)
#
# Reads from your current az login. Run `az login` and `az account set
# --subscription 01e2f327-74ac-451e-8ad9-1f923a06d634` first.

[CmdletBinding()]
param(
    [string] $SubscriptionId = '01e2f327-74ac-451e-8ad9-1f923a06d634',
    [string] $Location = 'australiaeast',
    [string] $RgName = 'dsc-fleet-dashboard',
    [string] $LabRgName = 'dsc-v3',
    [string] $NameSuffix = 'dsc',
    [string] $DeploymentName = ('phase1-{0:yyyyMMdd-HHmmss}' -f (Get-Date)),
    [switch] $WhatIfOnly,
    [switch] $SkipWhatIf,
    [switch] $SkipLabRbac
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bicep = Join-Path $root 'bicep\main.bicep'
if (-not (Test-Path $bicep)) {
    throw "main.bicep not found at $bicep"
}

Write-Host "Setting active subscription: $SubscriptionId" -ForegroundColor Cyan
az account set --subscription $SubscriptionId | Out-Null

$current = az account show --query '{name:name, id:id}' -o json | ConvertFrom-Json
Write-Host ("  Active: {0} ({1})" -f $current.name, $current.id) -ForegroundColor DarkGray

$assignVmContributor = if ($SkipLabRbac) { 'false' } else { 'true' }

$paramArgs = @(
    "location=$Location",
    "rgName=$RgName",
    "labRgName=$LabRgName",
    "nameSuffix=$NameSuffix",
    "assignVmContributor=$assignVmContributor"
)

if (-not $SkipWhatIf) {
    Write-Host "`nRunning what-if (no changes will be made)..." -ForegroundColor Cyan
    az deployment sub what-if `
        --name $DeploymentName `
        --location $Location `
        --template-file $bicep `
        --parameters @paramArgs
    if ($LASTEXITCODE -ne 0) { throw "what-if failed (exit $LASTEXITCODE)" }
}

if ($WhatIfOnly) {
    Write-Host "`n-WhatIfOnly set; exiting without deploying." -ForegroundColor Yellow
    return
}

if (-not $SkipWhatIf) {
    $confirm = Read-Host "`nProceed with deployment? [y/N]"
    if ($confirm -notmatch '^(y|yes)$') {
        Write-Host "Aborted." -ForegroundColor Yellow
        return
    }
}

Write-Host "`nDeploying ($DeploymentName)..." -ForegroundColor Cyan
$deployJson = az deployment sub create `
    --name $DeploymentName `
    --location $Location `
    --template-file $bicep `
    --parameters @paramArgs `
    --output json
if ($LASTEXITCODE -ne 0) { throw "deployment failed (exit $LASTEXITCODE)" }

$deploy = $deployJson | ConvertFrom-Json
$out = $deploy.properties.outputs

Write-Host "`n=== Phase 1 outputs ===" -ForegroundColor Green
Write-Host ("Resource group:        {0}" -f $out.resourceGroupName.value)
Write-Host ("Location:              {0}" -f $out.location.value)
Write-Host ("ACR login server:      {0}" -f $out.acrLoginServer.value)
Write-Host ("ACR name:              {0}" -f $out.acrName.value)
Write-Host ("UAMI resourceId:       {0}" -f $out.identityResourceId.value)
Write-Host ("UAMI principalId:      {0}" -f $out.identityPrincipalId.value)
Write-Host ("UAMI clientId:         {0}" -f $out.identityClientId.value)
Write-Host ("Storage account:       {0}" -f $out.storageAccountName.value)
Write-Host ("ACA env id:            {0}" -f $out.containerAppsEnvironmentId.value)
Write-Host ("ACA env default domain:{0}" -f $out.containerAppsEnvironmentDefaultDomain.value)
Write-Host ("Log Analytics ws id:   {0}" -f $out.logAnalyticsWorkspaceId.value)

# Persist the web URL to .azure/secrets.local.json so setup-entra.ps1 can pick it up
# without requiring the user to copy/paste the FQDN by hand.
$repoRoot    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$secretsDir  = Join-Path $repoRoot '.azure'
$secretsFile = Join-Path $secretsDir 'secrets.local.json'
if (-not (Test-Path $secretsDir)) { New-Item -ItemType Directory -Path $secretsDir | Out-Null }
$secrets = @{}
if (Test-Path $secretsFile) {
    $secrets = Get-Content $secretsFile -Raw | ConvertFrom-Json -AsHashtable
}
$defaultDomain = $out.containerAppsEnvironmentDefaultDomain.value
$secrets.resourceGroup    = $out.resourceGroupName.value
$secrets.acrLoginServer   = $out.acrLoginServer.value
$secrets.acrName          = $out.acrName.value
$secrets.identityClientId = $out.identityClientId.value
$secrets.acaDefaultDomain = $defaultDomain
$secrets.webUrl           = "https://web.$defaultDomain"
$secrets.apiUrl           = "https://api.$defaultDomain"
$secrets | ConvertTo-Json | Set-Content -Path $secretsFile -Encoding UTF8
Write-Host ("Saved infra outputs:   {0}" -f $secretsFile)

Write-Host "`nNext: ./azure/scripts/setup-entra.ps1 (web URL is auto-detected)." -ForegroundColor Cyan
