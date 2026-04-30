# Create / update the Entra app registration that fronts the dashboard.
#
# Uses the Microsoft.Graph PowerShell SDK natively (Connect-MgGraph + Mg cmdlets)
# rather than the Azure CLI, because the az CLI's cached Graph token does not
# survive Continuous Access Evaluation challenges and silently fails on tenants
# with strict Conditional Access. Connect-MgGraph performs an interactive MSAL
# auth that handles CAE properly.
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
    Write-Host "Cannot create the app registration: $Reason" -ForegroundColor Red
    Write-Host ""
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
    Write-Host "  4. The new app -> Manifest -> set api.requestedAccessTokenVersion = 2 (so v2 tokens are issued)."
    Write-Host "  5. The new app -> API permissions -> Microsoft Graph -> Delegated -> User.Read (already there by default)."
    Write-Host "     -> Grant admin consent for the tenant (button at the top)."
    Write-Host "  6. Copy the Application (client) ID and write it to:"
    Write-Host "       $secretsFile"
    Write-Host "     under the keys: entraTenantId, entraClientId"
    exit 1
}

# ---------------------------------------------------------------------------
# Microsoft Graph SDK bootstrap
# ---------------------------------------------------------------------------
# We only need three sub-modules — avoid pulling the ~200MB meta-module.
$requiredModules = @(
    'Microsoft.Graph.Authentication',
    'Microsoft.Graph.Applications',
    'Microsoft.Graph.Identity.SignIns'
)

foreach ($mod in $requiredModules) {
    if (-not (Get-Module -ListAvailable -Name $mod)) {
        Write-Host "Installing PowerShell module $mod (CurrentUser scope)..." -ForegroundColor Cyan
        try {
            Install-Module -Name $mod -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
        } catch {
            throw "Failed to install $mod. Run as admin and try: Install-Module $mod -Scope AllUsers -Force. Error: $_"
        }
    }
    Import-Module $mod -ErrorAction Stop
}

# Tenant context: pull from az if available (no Mg call needed), else from params.
$tenantId = $null
try { $tenantId = (az account show --query tenantId -o tsv 2>$null) } catch {}
if (-not $tenantId) { $tenantId = $p.tenantId }
if (-not $tenantId) {
    throw "Could not resolve tenantId. Run 'az login' first or set 'tenantId' in azure/parameters.jsonc."
}

Write-Host "Tenant:        $tenantId"
Write-Host "Display name:  $DisplayName"
Write-Host "SPA redirects: $WebUrl"
$ExtraRedirects | ForEach-Object { Write-Host "               $_" }

# ---------------------------------------------------------------------------
# Connect to Microsoft Graph (interactive — handles CAE / Conditional Access)
# ---------------------------------------------------------------------------
$requiredScopes = @(
    'Application.ReadWrite.All',
    'Directory.ReadWrite.All',
    'DelegatedPermissionGrant.ReadWrite.All'
)

# Reuse existing connection if one with sufficient scopes is already in place.
$existingCtx = $null
try { $existingCtx = Get-MgContext } catch {}
$needConnect = $true
if ($existingCtx -and $existingCtx.TenantId -eq $tenantId) {
    $haveAll = $true
    foreach ($s in $requiredScopes) {
        if ($existingCtx.Scopes -notcontains $s) { $haveAll = $false; break }
    }
    if ($haveAll) {
        Write-Host "Reusing existing Microsoft Graph session (account: $($existingCtx.Account))." -ForegroundColor DarkCyan
        $needConnect = $false
    }
}

if ($needConnect) {
    Write-Host "Connecting to Microsoft Graph (interactive)..." -ForegroundColor Cyan
    try {
        Connect-MgGraph -TenantId $tenantId -Scopes $requiredScopes -NoWelcome -ErrorAction Stop | Out-Null
    } catch {
        Show-ManualSteps "Connect-MgGraph failed: $($_.Exception.Message)"
    }
    $ctx = Get-MgContext
    Write-Host "Connected as: $($ctx.Account) (tenant $($ctx.TenantId))" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 1) Create or look up the app registration
# ---------------------------------------------------------------------------
$existing = $null
try {
    $existing = Get-MgApplication -Filter "displayName eq '$DisplayName'" -Top 1 -ErrorAction Stop
} catch {
    Show-ManualSteps "Get-MgApplication failed: $($_.Exception.Message)"
}

if ($existing) {
    $appObj = $existing
    Write-Host "`nFound existing app: $($appObj.AppId)" -ForegroundColor Yellow
} else {
    Write-Host "`nCreating app registration..." -ForegroundColor Cyan
    try {
        $appObj = New-MgApplication `
            -DisplayName $DisplayName `
            -SignInAudience 'AzureADMyOrg' `
            -ErrorAction Stop
    } catch {
        Show-ManualSteps "New-MgApplication failed: $($_.Exception.Message)"
    }
    Write-Host "Created app: $($appObj.AppId)" -ForegroundColor Green
}

$appId    = $appObj.AppId
$objectId = $appObj.Id
if (-not $objectId) { throw "Could not resolve object id for app $appId" }

# ---------------------------------------------------------------------------
# 2) SPA redirect URIs (no implicit grant; PKCE only)
# ---------------------------------------------------------------------------
$allRedirects = @(@($WebUrl) + @($ExtraRedirects) | Select-Object -Unique | Where-Object { $_ })

Write-Host "Configuring SPA redirect URIs..." -ForegroundColor Cyan
try {
    Update-MgApplication `
        -ApplicationId $objectId `
        -Spa @{ RedirectUris = @($allRedirects) } `
        -Web @{
            RedirectUris = @()
            ImplicitGrantSettings = @{
                EnableAccessTokenIssuance = $false
                EnableIdTokenIssuance     = $false
            }
        } `
        -ErrorAction Stop
} catch {
    Show-ManualSteps "Failed to set SPA redirect URIs: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 3) Identifier URI + access_as_user scope + v2 access tokens
# ---------------------------------------------------------------------------
$identifierUri = "api://$appId"

# Reuse the existing scope id if present so MSAL caches don't get invalidated.
$existingScopes = @()
try {
    $current = Get-MgApplication -ApplicationId $objectId -ErrorAction Stop
    if ($current.Api -and $current.Api.Oauth2PermissionScopes) {
        $existingScopes = @($current.Api.Oauth2PermissionScopes)
    }
} catch {}
$scopeId = ($existingScopes | Where-Object { $_.Value -eq 'access_as_user' }).Id
if (-not $scopeId) { $scopeId = [guid]::NewGuid().ToString() }

Write-Host "Configuring Expose API + access_as_user scope (v2 tokens)..." -ForegroundColor Cyan
try {
    Update-MgApplication `
        -ApplicationId $objectId `
        -IdentifierUris @($identifierUri) `
        -Api @{
            # v2 tokens use the modern issuer (login.microsoftonline.com/<tid>/v2.0)
            # which is what apps/api/src/lib/entraAuth.ts expects.
            RequestedAccessTokenVersion = 2
            Oauth2PermissionScopes = @(
                @{
                    Id                      = $scopeId
                    AdminConsentDescription = 'Allow the app to call the DSC Fleet Dashboard API on behalf of the signed-in user.'
                    AdminConsentDisplayName = 'Access DSC Fleet Dashboard'
                    UserConsentDescription  = 'Allow the app to call the DSC Fleet Dashboard API on your behalf.'
                    UserConsentDisplayName  = 'Access DSC Fleet Dashboard'
                    IsEnabled               = $true
                    Type                    = 'User'
                    Value                   = 'access_as_user'
                }
            )
        } `
        -ErrorAction Stop
} catch {
    Show-ManualSteps "Failed to configure Expose API / scope: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 4) RequiredResourceAccess: Graph User.Read + self access_as_user
# ---------------------------------------------------------------------------
# Constants
$graphAppId         = '00000003-0000-0000-c000-000000000000'   # Microsoft Graph
$userReadScopeId    = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'   # Graph User.Read (delegated)

Write-Host "Setting required API permissions (Graph User.Read + self access_as_user)..." -ForegroundColor Cyan
try {
    Update-MgApplication `
        -ApplicationId $objectId `
        -RequiredResourceAccess @(
            @{
                ResourceAppId  = $graphAppId
                ResourceAccess = @(
                    @{ Id = $userReadScopeId; Type = 'Scope' }
                )
            },
            @{
                ResourceAppId  = $appId
                ResourceAccess = @(
                    @{ Id = $scopeId; Type = 'Scope' }
                )
            }
        ) `
        -ErrorAction Stop
} catch {
    Write-Host "WARNING: Update-MgApplication (RequiredResourceAccess) failed: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "         Users will be prompted to consent on first sign-in." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 5) Ensure the app's Service Principal exists, then grant admin consent
#    (admin consent is best-effort: Privileged Role Admin / GA only).
# ---------------------------------------------------------------------------
$clientSp = $null
try { $clientSp = Get-MgServicePrincipal -Filter "appId eq '$appId'" -Top 1 -ErrorAction Stop } catch {}
if (-not $clientSp) {
    Write-Host "Creating service principal for app..." -ForegroundColor Cyan
    try {
        $clientSp = New-MgServicePrincipal -AppId $appId -ErrorAction Stop
    } catch {
        Write-Host "WARNING: New-MgServicePrincipal failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

$graphSp = $null
try { $graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'" -Top 1 -ErrorAction Stop } catch {}

function Grant-AdminConsentScope {
    param(
        [string] $ClientSpId,
        [string] $ResourceSpId,
        [string] $Scope
    )
    if (-not $ClientSpId -or -not $ResourceSpId) { return }
    # If a grant already exists for (clientId,resourceId,AllPrincipals), patch it; else create.
    $existing = $null
    try {
        $existing = Get-MgOauth2PermissionGrant -Filter "clientId eq '$ClientSpId' and resourceId eq '$ResourceSpId' and consentType eq 'AllPrincipals'" -Top 1 -ErrorAction Stop
    } catch {}
    if ($existing) {
        $scopes = ($existing.Scope -split ' ') + $Scope | Where-Object { $_ } | Select-Object -Unique
        try {
            Update-MgOauth2PermissionGrant -OAuth2PermissionGrantId $existing.Id -Scope ($scopes -join ' ') -ErrorAction Stop
        } catch {
            Write-Host "WARNING: could not update existing OAuth2 grant: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    } else {
        try {
            New-MgOauth2PermissionGrant -BodyParameter @{
                clientId    = $ClientSpId
                consentType = 'AllPrincipals'
                resourceId  = $ResourceSpId
                scope       = $Scope
            } -ErrorAction Stop | Out-Null
        } catch {
            Write-Host "WARNING: admin consent for '$Scope' not granted (need Privileged Role Admin / GA): $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "         Individual users will consent on first sign-in." -ForegroundColor Yellow
        }
    }
}

Write-Host "Granting admin consent (best-effort)..." -ForegroundColor Cyan
Grant-AdminConsentScope -ClientSpId $clientSp.Id -ResourceSpId $graphSp.Id  -Scope 'User.Read'
Grant-AdminConsentScope -ClientSpId $clientSp.Id -ResourceSpId $clientSp.Id -Scope 'access_as_user'

# ---------------------------------------------------------------------------
# 6) Persist to secrets file
# ---------------------------------------------------------------------------
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
