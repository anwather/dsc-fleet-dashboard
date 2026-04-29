# Create / update the Entra app registration that fronts the dashboard.
#
# - Single tenant
# - SPA platform with redirect URIs for localhost dev + the deployed web URL
# - Expose API: api://<clientId> with scope "access_as_user"
# - Microsoft Graph User.Read delegated permission (for displaying the user's name)
# - Persists clientId + tenantId to .azure/secrets.local.json
#
# If the signed-in user lacks Application Administrator rights, the script
# prints the manual portal steps and exits non-zero.
#
# Usage:
#   ./azure/scripts/setup-entra.ps1
#   ./azure/scripts/setup-entra.ps1 -DisplayName "DSC Fleet Dashboard" -WebUrl "https://web.example.com"

[CmdletBinding()]
param(
    [string] $DisplayName    = 'DSC Fleet Dashboard',
    [string] $WebUrl         = 'https://web.mangopond-a279fde4.australiaeast.azurecontainerapps.io',
    [string[]] $ExtraRedirects = @('http://localhost:5173', 'http://localhost:5173/')
)

$ErrorActionPreference = 'Stop'

$repoRoot    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$secretsDir  = Join-Path $repoRoot '.azure'
$secretsFile = Join-Path $secretsDir 'secrets.local.json'
if (-not (Test-Path $secretsDir)) { New-Item -ItemType Directory -Path $secretsDir | Out-Null }

function Show-ManualSteps {
    param([string] $Reason)
    Write-Host ""
    Write-Host "Cannot create the app registration via az CLI: $Reason" -ForegroundColor Red
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

# 1) Create or update the app registration.
$existingId = az ad app list --display-name $DisplayName --query "[0].appId" -o tsv 2>$null
if ($existingId) {
    Write-Host "`nFound existing app: $existingId" -ForegroundColor Yellow
    $appId = $existingId
}
else {
    Write-Host "`nCreating app registration..." -ForegroundColor Cyan
    $createJson = az ad app create `
        --display-name $DisplayName `
        --sign-in-audience AzureADMyOrg `
        --output json 2>&1
    if ($LASTEXITCODE -ne 0) {
        Show-ManualSteps "az ad app create failed: $createJson"
    }
    $appId = ($createJson | ConvertFrom-Json).appId
    Write-Host "Created app: $appId" -ForegroundColor Green
}

$objectId = az ad app show --id $appId --query id -o tsv
if (-not $objectId) { throw "Could not resolve object id for app $appId" }

# 2) SPA redirect URIs (no implicit grant; PKCE only).
$allRedirects = @($WebUrl) + $ExtraRedirects | Select-Object -Unique
$spaPayload = @{
    spa = @{
        redirectUris = $allRedirects
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
