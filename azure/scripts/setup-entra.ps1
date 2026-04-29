# Create / update the Entra app registration that fronts the dashboard.
#
# - Single tenant
# - SPA platform with one redirect URI: the deployed web URL
# - Expose API: api://<clientId> with scope "access_as_user"
# - Microsoft Graph User.Read delegated permission (for displaying the user's name)
# - Persists clientId + tenantId to .azure/secrets.local.json
#
# Web URL is auto-detected from .azure/secrets.local.json (written by deploy.ps1).
# Pass -WebUrl explicitly if you need to override.
#
# If the signed-in user lacks Application Administrator rights, the script
# prints the manual portal steps and exits non-zero.
#
# Usage:
#   ./azure/scripts/setup-entra.ps1
#   ./azure/scripts/setup-entra.ps1 -DisplayName "DSC Fleet Dashboard" -WebUrl "https://web.example.com"

[CmdletBinding()]
param(
    [string] $DisplayName,
    [string] $WebUrl         = '',
    [string[]] $ExtraRedirects = @()
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_load-params.ps1')
$p = Get-DeploymentParams
if (-not $DisplayName) { $DisplayName = $p.displayName }

$repoRoot    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$secretsDir  = Join-Path $repoRoot '.azure'
$secretsFile = Join-Path $secretsDir 'secrets.local.json'
if (-not (Test-Path $secretsDir)) { New-Item -ItemType Directory -Path $secretsDir | Out-Null }

if (-not $WebUrl) {
    if (-not (Test-Path $secretsFile)) {
        throw "WebUrl not provided and $secretsFile not found. Run azure/scripts/deploy.ps1 first (it writes the web URL), or pass -WebUrl explicitly."
    }
    $existing = Get-Content $secretsFile -Raw | ConvertFrom-Json -AsHashtable
    $WebUrl = $existing.webUrl
    if (-not $WebUrl) {
        throw "secrets.local.json has no 'webUrl' key. Re-run azure/scripts/deploy.ps1 (it now persists the deployed web URL), or pass -WebUrl explicitly."
    }
    Write-Host "Using web URL from $($secretsFile): $WebUrl" -ForegroundColor DarkCyan
}

function Show-ManualSteps {
    param([string] $Reason)
    Write-Host ""
    Write-Host "Cannot create the app registration via az CLI: $Reason" -ForegroundColor Red
    if ($Reason -match 'TokenCreatedWithOutdatedPolicies|InteractionRequired|continuous access evaluation') {
        Write-Host ""
        Write-Host "This is a Continuous Access Evaluation (CAE) challenge — the cached" -ForegroundColor Yellow
        Write-Host "Microsoft Graph token was invalidated by a tenant policy change." -ForegroundColor Yellow
        Write-Host "Try this first (one line) and re-run setup-entra.ps1:" -ForegroundColor Yellow
        Write-Host "  az logout; az login --scope https://graph.microsoft.com/.default" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "If it still fails after a fresh login, fall back to the manual steps below." -ForegroundColor Yellow
    }
    Write-Host "Manual portal steps:" -ForegroundColor Yellow
    Write-Host "  1. Azure Portal -> Microsoft Entra ID -> App registrations -> New registration"
    Write-Host "     - Name: $DisplayName"
    Write-Host "     - Supported account types: Accounts in this organizational directory only (single tenant)"
    Write-Host "     - Redirect URI: leave blank for now"
    Write-Host "  2. The new app -> Authentication -> Add a platform -> Single-page application"
    Write-Host "     - Redirect URIs:"
    Write-Host "         $WebUrl"
    foreach ($u in $ExtraRedirects) { Write-Host "         $u" }
    Write-Host "     - Front-channel logout URL: (blank)"
    Write-Host "     - Implicit grant: leave both checkboxes UNCHECKED (PKCE only)"
    Write-Host "  3. The new app -> Expose an API"
    Write-Host "     - Application ID URI: api://<the-app-client-id>   (click Set; accept the default)"
    Write-Host "     - Add a scope:"
    Write-Host "         Scope name:    access_as_user"
    Write-Host "         Who can consent: Admins and users"
    Write-Host "         Admin consent display name: Access DSC Fleet Dashboard"
    Write-Host "         Admin consent description:  Allow the app to call the dashboard API on behalf of the signed-in user."
    Write-Host "         User consent display name:  Access DSC Fleet Dashboard"
    Write-Host "         User consent description:   Allow the app to call the dashboard API on your behalf."
    Write-Host "         State:        Enabled"
    Write-Host "  4. The new app -> API permissions -> Microsoft Graph -> Delegated -> User.Read (already there by default)."
    Write-Host "     -> Grant admin consent for the tenant (button at the top)."
    Write-Host "  5. Copy the Application (client) ID and re-run with -ClientId, OR write it to:"
    Write-Host "       $secretsFile"
    Write-Host "     under the keys: entraTenantId, entraClientId"
    exit 1
}

# Tenant context
$tenantId = az account show --query tenantId -o tsv
if (-not $tenantId) { throw "Not logged in. Run 'az login' first." }
Write-Host "Tenant:        $tenantId"
Write-Host "Display name:  $DisplayName"
Write-Host "SPA redirects: $WebUrl"
$ExtraRedirects | ForEach-Object { Write-Host "               $_" }

# Proactively refresh the Microsoft Graph access token. This avoids the most
# common failure mode for this script:
#   "Continuous access evaluation resulted in challenge with result:
#    InteractionRequired and code: TokenCreatedWithOutdatedPolicies"
# CAE invalidates cached Graph tokens whenever a tenant policy changes
# (Conditional Access, MFA, sign-in frequency, group membership, etc.). The
# Azure CLI's silent token refresh can't satisfy CAE on its own, so we force
# an interactive re-login scoped to Microsoft Graph before any 'az ad ...'
# call. This is a no-op on a freshly-cached token.
function Test-GraphToken {
    $null = az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Update-GraphTokenInteractive {
    param([string] $Reason)
    Write-Host ""
    Write-Host "Refreshing Microsoft Graph access token..." -ForegroundColor Cyan
    if ($Reason) { Write-Host "  Reason: $Reason" -ForegroundColor DarkYellow }
    az login --scope https://graph.microsoft.com/.default --tenant $tenantId --allow-no-subscriptions | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Graph token refresh failed (az login --scope https://graph.microsoft.com/.default exit $LASTEXITCODE)."
    }
    # Re-pin the original Azure subscription context (interactive --scope login can switch it)
    az account set --subscription $p.subscriptionId 2>$null | Out-Null
}

function Invoke-AzGraph {
    # Wrap an `az ...` call (passed as a scriptblock) and retry once if CAE
    # rejects the cached Graph token. Returns combined stdout+stderr; sets
    # $script:LastExit to the underlying exit code.
    param(
        [Parameter(Mandatory)] [scriptblock] $Call,
        [string] $Description = 'az graph call'
    )
    $output = & $Call 2>&1
    $script:LastExit = $LASTEXITCODE
    if ($script:LastExit -ne 0 -and ($output -match 'TokenCreatedWithOutdatedPolicies|InteractionRequired|continuous access evaluation' )) {
        Update-GraphTokenInteractive "CAE challenge during '$Description'"
        $output = & $Call 2>&1
        $script:LastExit = $LASTEXITCODE
    }
    return $output
}

if (-not (Test-GraphToken)) {
    Update-GraphTokenInteractive 'no cached Graph token'
}

# 1) Create or update the app registration.
$existingId = az ad app list --display-name $DisplayName --query "[0].appId" -o tsv 2>$null
if ($existingId) {
    Write-Host "`nFound existing app: $existingId" -ForegroundColor Yellow
    $appId = $existingId
}
else {
    Write-Host "`nCreating app registration..." -ForegroundColor Cyan
    $createJson = Invoke-AzGraph -Description 'az ad app create' -Call {
        az ad app create `
            --display-name $DisplayName `
            --sign-in-audience AzureADMyOrg `
            --output json
    }
    if ($script:LastExit -ne 0) {
        Show-ManualSteps "az ad app create failed: $createJson"
    }
    $appId = ($createJson | ConvertFrom-Json).appId
    Write-Host "Created app: $appId" -ForegroundColor Green
}

$objectId = az ad app show --id $appId --query id -o tsv
if (-not $objectId) { throw "Could not resolve object id for app $appId" }

# 2) SPA redirect URIs (no implicit grant; PKCE only).
# Force array shape: a single-element pipeline result unwraps to a scalar string,
# which ConvertTo-Json then serialises as "redirectUris": "https://..." instead
# of an array — Graph rejects that with "A 'StartArray' node was expected".
$allRedirects = @(@($WebUrl) + @($ExtraRedirects) | Select-Object -Unique | Where-Object { $_ })
$spaPayload = @{
    spa = @{
        redirectUris = @($allRedirects)
    }
    web = @{
        redirectUris = @()
        implicitGrantSettings = @{
            enableAccessTokenIssuance = $false
            enableIdTokenIssuance     = $false
        }
    }
} | ConvertTo-Json -Depth 6 -Compress

# Use az rest because `az ad app update` doesn't fully support the SPA platform.
$tmpFile = New-TemporaryFile
$spaPayload | Set-Content -Path $tmpFile -Encoding UTF8
try {
    Write-Host "Configuring SPA redirect URIs..." -ForegroundColor Cyan
    az rest --method PATCH `
        --uri "https://graph.microsoft.com/v1.0/applications/$objectId" `
        --headers "Content-Type=application/json" `
        --body "@$($tmpFile.FullName)" | Out-Null
    if ($LASTEXITCODE -ne 0) { Show-ManualSteps "Failed to set SPA redirect URIs" }
}
finally {
    Remove-Item $tmpFile -ErrorAction SilentlyContinue
}

# 3) Identifier URI (App ID URI = api://<clientId>) and access_as_user scope.
$identifierUri = "api://$appId"

# Permission scope GUID — stable and re-creatable. Generate deterministically per app.
$existingScopes = az ad app show --id $appId --query "api.oauth2PermissionScopes" -o json | ConvertFrom-Json
$scopeId = ($existingScopes | Where-Object { $_.value -eq 'access_as_user' }).id
if (-not $scopeId) { $scopeId = [guid]::NewGuid().ToString() }

$apiPayload = @{
    identifierUris = @($identifierUri)
    api = @{
        oauth2PermissionScopes = @(
            @{
                id                      = $scopeId
                adminConsentDescription = 'Allow the app to call the DSC Fleet Dashboard API on behalf of the signed-in user.'
                adminConsentDisplayName = 'Access DSC Fleet Dashboard'
                userConsentDescription  = 'Allow the app to call the DSC Fleet Dashboard API on your behalf.'
                userConsentDisplayName  = 'Access DSC Fleet Dashboard'
                isEnabled               = $true
                type                    = 'User'
                value                   = 'access_as_user'
            }
        )
    }
} | ConvertTo-Json -Depth 8 -Compress

$tmpFile = New-TemporaryFile
$apiPayload | Set-Content -Path $tmpFile -Encoding UTF8
try {
    Write-Host "Configuring Expose API + access_as_user scope..." -ForegroundColor Cyan
    az rest --method PATCH `
        --uri "https://graph.microsoft.com/v1.0/applications/$objectId" `
        --headers "Content-Type=application/json" `
        --body "@$($tmpFile.FullName)" | Out-Null
    if ($LASTEXITCODE -ne 0) { Show-ManualSteps "Failed to configure Expose API / scope" }
}
finally {
    Remove-Item $tmpFile -ErrorAction SilentlyContinue
}

# 4) Microsoft Graph User.Read delegated permission (resourceAppId 00000003-0000-0000-c000-000000000000;
#    User.Read scope id e1fe6dd8-ba31-4d61-89e7-88639da4683d).
Write-Host "Adding Microsoft Graph User.Read delegated permission..." -ForegroundColor Cyan
az ad app permission add `
    --id $appId `
    --api 00000003-0000-0000-c000-000000000000 `
    --api-permissions e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope 2>$null | Out-Null

# Try admin consent. This is a separate permission requiring Privileged Role Admin / GA;
# it may fail silently for non-admins — that's OK, individual users will consent on first sign-in.
az ad app permission grant --id $appId --scope User.Read --api 00000003-0000-0000-c000-000000000000 2>$null | Out-Null

# 5) Persist to secrets file.
$secrets = @{}
if (Test-Path $secretsFile) {
    $secrets = Get-Content $secretsFile -Raw | ConvertFrom-Json -AsHashtable
}
$secrets.entraTenantId = $tenantId
$secrets.entraClientId = $appId
$secrets | ConvertTo-Json | Set-Content -Path $secretsFile -Encoding UTF8

Write-Host "`n=== Entra app ready ===" -ForegroundColor Green
Write-Host "Display name:        $DisplayName"
Write-Host "Tenant:              $tenantId"
Write-Host "Client (App) ID:     $appId"
Write-Host "App ID URI:          $identifierUri"
Write-Host "API scope:           $identifierUri/access_as_user"
Write-Host "Saved to:            $secretsFile"
Write-Host ""
Write-Host "Next: ./azure/scripts/build-and-push.ps1 -Only web -Tag latest"
Write-Host "      ./azure/scripts/deploy-apps.ps1"
