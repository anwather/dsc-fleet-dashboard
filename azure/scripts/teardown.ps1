# Tear down everything deploy.ps1 / setup-entra.ps1 / deploy-apps.ps1 created.
#
# What this removes (in order):
#   1. The dashboard resource group (ACR, ACA env, container apps, Postgres
#      storage, log analytics, key vault, managed identity, ...).
#   2. Orphaned VM Contributor role assignment on the lab RG (the one
#      crossRgRole.bicep created for the dashboard's managed identity).
#      Scoped delete by principal id — your other lab role assignments are
#      left alone.
#   3. The Entra app registration (and its service principal + grants).
#   4. .azure/secrets.local.json so the next setup-entra.ps1 starts clean.
#
# What this does NOT touch:
#   - The lab resource group itself or any VMs / DSC artefacts inside it.
#   - Your Azure subscription, your Entra tenant, your az login.
#   - parameters.jsonc (your settings file).
#
# Usage:
#   ./azure/scripts/teardown.ps1                    # interactive: prompts before each destructive step
#   ./azure/scripts/teardown.ps1 -Yes               # skip confirmations (CI / scripted use)
#   ./azure/scripts/teardown.ps1 -KeepEntraApp      # leave the app registration in place
#   ./azure/scripts/teardown.ps1 -KeepSecretsFile   # leave .azure/secrets.local.json in place
#   ./azure/scripts/teardown.ps1 -WhatIf            # show what WOULD be deleted, change nothing
#   ./azure/scripts/teardown.ps1 -NoWait            # fire-and-forget RG delete (returns immediately)

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string] $SubscriptionId,
    [string] $RgName,
    [string] $LabRgName,
    [switch] $Yes,
    [switch] $KeepEntraApp,
    [switch] $KeepSecretsFile,
    [switch] $NoWait
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_load-params.ps1')
$p = Get-DeploymentParams
if (-not $SubscriptionId) { $SubscriptionId = $p.subscriptionId }
if (-not $RgName)         { $RgName         = $p.rgName }
if (-not $LabRgName)      { $LabRgName      = $p.labRgName }

$repoRoot    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$secretsFile = Join-Path $repoRoot '.azure\secrets.local.json'

function Confirm-Step {
    param([string] $Prompt)
    if ($Yes -or $WhatIfPreference) { return $true }
    $ans = Read-Host "$Prompt [y/N]"
    return $ans -match '^(y|yes)$'
}

# ---- preflight -------------------------------------------------------------

Write-Host "=== dsc-fleet-dashboard teardown ===" -ForegroundColor Cyan
Write-Host "Subscription:  $SubscriptionId"
Write-Host "Dashboard RG:  $RgName"
Write-Host "Lab RG:        $LabRgName  (kept; only the dashboard's role assignment will be removed)"
Write-Host "Entra app:     $(if ($KeepEntraApp) { '(kept)' } else { 'will be deleted (use -KeepEntraApp to skip)' })"
Write-Host "Secrets file:  $(if ($KeepSecretsFile) { "$secretsFile (kept)" } else { "$secretsFile (will be deleted)" })"
Write-Host ""

az account set --subscription $SubscriptionId | Out-Null
$current = az account show --query '{name:name, id:id}' -o json | ConvertFrom-Json
Write-Host ("Active subscription: {0} ({1})" -f $current.name, $current.id) -ForegroundColor DarkGray

# Resolve identity principal id + Entra app id BEFORE we delete the RG, since
# we need them for the cross-RG role-assignment cleanup and the Entra delete.

$identityPrincipalId = $null
$rgExists = $false
$rgCheck = az group show --name $RgName --query id -o tsv 2>$null
if ($LASTEXITCODE -eq 0 -and $rgCheck) {
    $rgExists = $true
    Write-Host "`nLooking up managed-identity principal id (for lab RBAC cleanup)..." -ForegroundColor Cyan
    # The identity name from main.bicep / parameters defaults to "id-dsc-fleet-dashboard".
    # We don't hard-code it — discover whatever user-assigned identities live in the RG.
    $idsJson = az identity list -g $RgName --query "[].{name:name,principalId:principalId}" -o json
    $ids = @($idsJson | ConvertFrom-Json)
    if ($ids.Count -ge 1) {
        $identityPrincipalId = $ids[0].principalId
        Write-Host ("  Found identity '{0}' principalId={1}" -f $ids[0].name, $identityPrincipalId) -ForegroundColor DarkGray
        if ($ids.Count -gt 1) {
            Write-Host "  WARNING: multiple managed identities in $RgName — using the first." -ForegroundColor Yellow
        }
    } else {
        Write-Host "  No managed identities found in $RgName — nothing to clean up on the lab RG." -ForegroundColor DarkGray
    }
} else {
    Write-Host "`nResource group $RgName does not exist (or you can't see it). Skipping RG delete." -ForegroundColor Yellow
}

$entraAppId = $null
if (-not $KeepEntraApp -and (Test-Path $secretsFile)) {
    try {
        $secrets = Get-Content $secretsFile -Raw | ConvertFrom-Json
        $entraAppId = $secrets.entraClientId
        if ($entraAppId) {
            Write-Host "Entra app to delete: $entraAppId  (from $secretsFile)" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "Could not parse $secretsFile — skipping Entra app delete." -ForegroundColor Yellow
    }
}

Write-Host ""

# ---- step 1: clean up the lab-RG role assignment --------------------------
# Do this BEFORE deleting the RG so we still have the principal id and the
# role assignment shows up cleanly. If we did it after, the role assignment
# would still be there (Azure doesn't auto-clean cross-scope assignments)
# but the principal would already be gone, making the listing look like an
# "Identity not found" stub.

if ($identityPrincipalId) {
    $labExists = $true
    $null = az group show --name $LabRgName --query id -o tsv 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Lab RG $LabRgName not found — skipping role-assignment cleanup." -ForegroundColor Yellow
        $labExists = $false
    }

    if ($labExists) {
        $labScope = "/subscriptions/$SubscriptionId/resourceGroups/$LabRgName"
        $assignmentsJson = az role assignment list `
            --assignee $identityPrincipalId `
            --scope $labScope `
            --query "[].{id:id, role:roleDefinitionName}" -o json 2>$null
        $assignments = @($assignmentsJson | ConvertFrom-Json)

        if ($assignments.Count -eq 0) {
            Write-Host "No role assignments for principal $identityPrincipalId on $LabRgName — nothing to clean up." -ForegroundColor DarkGray
        } else {
            Write-Host "Role assignments to remove on ${LabRgName}:" -ForegroundColor Cyan
            $assignments | ForEach-Object { Write-Host ("  - {0,-25} {1}" -f $_.role, $_.id) }
            if ($PSCmdlet.ShouldProcess($LabRgName, "remove $($assignments.Count) role assignment(s) for principal $identityPrincipalId")) {
                if (Confirm-Step "Remove these role assignments?") {
                    foreach ($a in $assignments) {
                        az role assignment delete --ids $a.id | Out-Null
                        Write-Host "  removed: $($a.role)" -ForegroundColor Green
                    }
                } else { Write-Host "Skipped role-assignment cleanup." -ForegroundColor Yellow }
            }
        }
    }
}

# ---- step 2: delete the resource group ------------------------------------

if ($rgExists) {
    Write-Host "`nThe following resources will be deleted with $RgName :" -ForegroundColor Cyan
    az resource list -g $RgName --query "[].{name:name,type:type}" -o table
    Write-Host ""

    if ($PSCmdlet.ShouldProcess($RgName, 'delete resource group (recursive)')) {
        if (Confirm-Step "DELETE resource group '$RgName' AND ALL RESOURCES IN IT?") {
            $waitFlag = if ($NoWait) { '--no-wait' } else { $null }
            Write-Host "Deleting $RgName (this can take 5-15 minutes)..." -ForegroundColor Cyan
            $args = @('group','delete','--name',$RgName,'--yes')
            if ($waitFlag) { $args += $waitFlag }
            az @args
            if ($NoWait) {
                Write-Host "Delete dispatched. Track with: az group show -n $RgName --query properties.provisioningState" -ForegroundColor DarkGray
            } else {
                Write-Host "Resource group deleted." -ForegroundColor Green
            }
        } else { Write-Host "Skipped RG delete." -ForegroundColor Yellow }
    }
}

# ---- step 3: delete the Entra app registration ----------------------------

if ($entraAppId -and -not $KeepEntraApp) {
    $appExists = $true
    $null = az ad app show --id $entraAppId --query id -o tsv 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`nEntra app $entraAppId not found (already deleted)." -ForegroundColor DarkGray
        $appExists = $false
    }
    if ($appExists) {
        $appName = az ad app show --id $entraAppId --query displayName -o tsv 2>$null
        Write-Host "`nEntra app to delete:" -ForegroundColor Cyan
        Write-Host ("  {0}  ({1})" -f $appName, $entraAppId)
        if ($PSCmdlet.ShouldProcess($entraAppId, "delete Entra app registration '$appName'")) {
            if (Confirm-Step "Delete Entra app registration '$appName'?") {
                az ad app delete --id $entraAppId
                Write-Host "Entra app deleted (service principal + grants removed automatically)." -ForegroundColor Green
            } else { Write-Host "Skipped Entra app delete." -ForegroundColor Yellow }
        }
    }
}

# ---- step 4: secrets file -------------------------------------------------

if (-not $KeepSecretsFile -and (Test-Path $secretsFile)) {
    if ($PSCmdlet.ShouldProcess($secretsFile, 'delete secrets file')) {
        if (Confirm-Step "Delete $secretsFile ?") {
            Remove-Item $secretsFile -Force
            Write-Host "Secrets file removed." -ForegroundColor Green
        } else { Write-Host "Kept $secretsFile." -ForegroundColor Yellow }
    }
}

Write-Host "`n=== Teardown complete ===" -ForegroundColor Green
Write-Host "To redeploy from scratch:" -ForegroundColor DarkGray
Write-Host "  ./azure/scripts/setup-entra.ps1"
Write-Host "  ./azure/scripts/deploy.ps1"
Write-Host "  ./azure/scripts/build-and-push.ps1"
Write-Host "  ./azure/scripts/deploy-apps.ps1"
