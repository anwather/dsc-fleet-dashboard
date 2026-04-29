// Subscription-scope deployment for dsc-fleet-dashboard ACA migration.
//
// What this creates (Phase 1 — infra only):
//   • Resource group `dsc-fleet-dashboard` in `australiaeast`
//   • Log Analytics workspace (PerGB2018, 7d retention, 1 GiB cap)
//   • ACR (Basic SKU)
//   • User-Assigned Managed Identity + role assignments
//       - acrpull on the ACR (same RG)
//       - Virtual Machine Contributor on the lab RG `dsc-v3` (cross-RG)
//   • Storage Account + SMB file share `pgdata` (100 GiB) for Postgres data
//   • Container Apps Environment (workload-profiles, Consumption) with the
//     storage account linked as a managed env storage named `pgdata`
//
// Container Apps themselves (web / api / postgres) are Phase 3 — not in this
// template. After Phase 1 deploys cleanly, build & push images (Phase 2),
// then add the apps module call here (Phase 3).

targetScope = 'subscription'

// -----------------------------------------------------------------------------
// Parameters
// -----------------------------------------------------------------------------
@description('Azure region for all resources. Pinned to lab region.')
param location string = 'australiaeast'

@description('Resource group that will hold the dashboard.')
param rgName string = 'dsc-fleet-dashboard'

@description('Lab resource group containing the Windows Server VMs the dashboard manages.')
param labRgName string = 'dsc-v3'

@description('Whether to assign Virtual Machine Contributor on the lab RG to the UAMI. Set to false if the deploying principal does not have role-assignment rights on the lab RG; you can do that step manually later.')
param assignVmContributor bool = true

@description('Whether to deploy the three Container Apps (postgres, api, web). Set to false to keep the deployment to infra only.')
param deployApps bool = false

@description('Container image tag (matches what was pushed to ACR by build-and-push.ps1).')
param imageTag string = 'latest'

@description('Postgres backend mode. "container" runs an in-env postgres container with Azure Files (NOT recommended — chmod fails on SMB). "managed" provisions Azure Database for PostgreSQL Flexible Server B1ms.')
@allowed([
  'container'
  'managed'
])
param postgresMode string = 'managed'

@description('Postgres password. Required when deployApps=true. For "managed" mode this is the flex-server admin password and the api app DATABASE_URL.')
@secure()
param pgPassword string = ''

@description('RUNAS_MASTER_KEY for AES-256-GCM encryption of password run-as creds. 32 bytes base64. Empty disables password run-as in the UI.')
@secure()
param runAsMasterKey string = ''

@description('Entra (Azure AD) tenant ID for dashboard auth. Required when deployApps=true.')
param entraTenantId string = ''

@description('Entra app registration client ID (also the API audience). Required when deployApps=true.')
param entraApiClientId string = ''

@description('Short name token used as a suffix to keep names globally unique-ish (ACR, storage).')
@minLength(2)
@maxLength(8)
param nameSuffix string = 'dsc'

@description('Tags applied to every resource.')
param tags object = {
  app: 'dsc-fleet-dashboard'
  env: 'shared'
  managedBy: 'bicep'
}

// -----------------------------------------------------------------------------
// Resource group
// -----------------------------------------------------------------------------
resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
  tags: tags
}

// -----------------------------------------------------------------------------
// Modules (deployed into rg)
// -----------------------------------------------------------------------------
module la 'modules/logAnalytics.bicep' = {
  name: 'log-analytics'
  scope: rg
  params: {
    location: location
    tags: tags
    workspaceName: 'log-${rgName}'
  }
}

module acr 'modules/acr.bicep' = {
  name: 'acr'
  scope: rg
  params: {
    location: location
    tags: tags
    // ACR names: 5-50 alphanumeric, globally unique. 'dscfleet' + suffix.
    registryName: toLower('dscfleet${nameSuffix}acr')
  }
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: rg
  params: {
    location: location
    tags: tags
    identityName: 'id-${rgName}'
    acrName: acr.outputs.name
  }
}

// Cross-RG role assignment: VM Contributor on the lab RG so the API can
// invoke Run-Command against dsc-01 / dsc-02 / future VMs.
module labRoles 'modules/crossRgRole.bicep' = if (assignVmContributor) {
  name: 'lab-rg-roles'
  scope: resourceGroup(labRgName)
  params: {
    principalId: identity.outputs.principalId
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  scope: rg
  params: {
    location: location
    tags: tags
    // Storage account names: 3-24 lowercase alphanumeric, globally unique.
    storageAccountName: toLower('dscfleet${nameSuffix}sa')
    pgShareName: 'pgdata'
    pgShareQuotaGiB: 100
  }
}

module env 'modules/containerEnv.bicep' = {
  name: 'aca-env'
  scope: rg
  params: {
    location: location
    tags: tags
    envName: 'cae-${rgName}'
    logAnalyticsCustomerId: la.outputs.customerId
    logAnalyticsSharedKey: la.outputs.primarySharedKey
    storageAccountName: storage.outputs.name
    pgShareName: storage.outputs.pgShareName
    pgManagedStorageName: 'pgdata'
  }
}

module pg 'modules/pgFlexible.bicep' = if (deployApps && postgresMode == 'managed') {
  name: 'pg-flex'
  scope: rg
  params: {
    location: location
    name: toLower('${rgName}-pg')
    adminPassword: pgPassword
  }
}

module apps 'modules/apps.bicep' = if (deployApps) {
  name: 'apps'
  scope: rg
  params: {
    location: location
    tags: tags
    environmentId: env.outputs.environmentId
    environmentDefaultDomain: env.outputs.defaultDomain
    pgManagedStorageName: 'pgdata'
    acrLoginServer: acr.outputs.loginServer
    identityResourceId: identity.outputs.resourceId
    identityClientId: identity.outputs.clientId
    imageTag: imageTag
    pgPassword: pgPassword
    runAsMasterKey: runAsMasterKey
    postgresMode: postgresMode
    managedPgHost: postgresMode == 'managed' ? pg!.outputs.fqdn : ''
    managedPgUser: postgresMode == 'managed' ? pg!.outputs.adminUser : ''
    entraTenantId: entraTenantId
    entraApiClientId: entraApiClientId
  }
}

// -----------------------------------------------------------------------------
// Outputs (used by deploy script + future phases)
// -----------------------------------------------------------------------------
output resourceGroupName string = rg.name
output location string = location
output acrLoginServer string = acr.outputs.loginServer
output acrName string = acr.outputs.name
output identityResourceId string = identity.outputs.resourceId
output identityPrincipalId string = identity.outputs.principalId
output identityClientId string = identity.outputs.clientId
output containerAppsEnvironmentId string = env.outputs.environmentId
output containerAppsEnvironmentDefaultDomain string = env.outputs.defaultDomain
output storageAccountName string = storage.outputs.name
output pgManagedStorageName string = 'pgdata'
output logAnalyticsWorkspaceId string = la.outputs.workspaceId
output apiFqdn string = deployApps ? apps!.outputs.apiFqdn : ''
output webFqdn string = deployApps ? apps!.outputs.webFqdn : ''
