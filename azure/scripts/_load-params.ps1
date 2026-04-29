# Helper: load deployment parameters from azure/parameters.json.
#
# Dot-source this from a deployment script:
#   . "$PSScriptRoot/_load-params.ps1"
#   $p = Get-DeploymentParams
#   if (-not $SubscriptionId) { $SubscriptionId = $p.subscriptionId }
#
# The file is JSONC (// line comments tolerated). Throws a friendly error
# pointing at parameters.example.jsonc if the file is missing.

function Get-DeploymentParams {
    [CmdletBinding()]
    param(
        # Optional explicit path. Defaults to <repoRoot>/azure/parameters.json.
        [string] $Path
    )

    if (-not $Path) {
        $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
        $Path = Join-Path $repoRoot 'azure\parameters.jsonc'
    }

    if (-not (Test-Path $Path)) {
        $parentDir = Split-Path -Parent $Path
        if (-not $parentDir) { $parentDir = (Get-Location).Path }
        $example = Join-Path $parentDir 'parameters.example.jsonc'
        throw @"
Deployment parameters file not found: $Path

Copy the template and edit it for your environment, then re-run:
  Copy-Item '$example' '$Path'
  notepad '$Path'   # or your editor of choice

Required keys: subscriptionId, location, rgName, labRgName, nameSuffix, displayName
"@
    }

    # Strip // line comments before JSON parse (JSONC support).
    $raw = Get-Content $Path -Raw
    $stripped = ($raw -split "`n" | ForEach-Object {
            $_ -replace '(^|[^:"])//.*$', '$1'
        }) -join "`n"

    try {
        $parsed = $stripped | ConvertFrom-Json -AsHashtable
    }
    catch {
        throw "Failed to parse $Path as JSON: $_"
    }

    $required = @('subscriptionId', 'location', 'rgName', 'labRgName', 'nameSuffix', 'displayName')
    $missing = @($required | Where-Object { -not $parsed.ContainsKey($_) -or [string]::IsNullOrWhiteSpace($parsed[$_]) })
    if ($missing.Count) {
        throw "Missing or empty required keys in ${Path}: $($missing -join ', ')"
    }

    if ($parsed.subscriptionId -eq '00000000-0000-0000-0000-000000000000') {
        throw "subscriptionId in $Path is still the placeholder. Edit it to your real subscription GUID."
    }

    return $parsed
}
