@description('Region.')
param location string

@description('Tags.')
param tags object

@description('ACA managed environment name.')
param envName string

@description('Log Analytics customer (workspace) ID.')
param logAnalyticsCustomerId string

@description('Log Analytics primary shared key.')
@secure()
param logAnalyticsSharedKey string

@description('Storage account hosting the pgdata SMB share.')
param storageAccountName string

@description('SMB file share name for Postgres data.')
param pgShareName string

@description('Logical name surfaced to Container Apps when mounting the share.')
param pgManagedStorageName string

resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource env 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {
  name: envName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

// Link the SMB file share into the env so Container Apps can mount it
// later via `volumes: [{ storageType: 'AzureFile', storageName: 'pgdata' }]`.
resource pgStorage 'Microsoft.App/managedEnvironments/storages@2024-10-02-preview' = {
  parent: env
  name: pgManagedStorageName
  properties: {
    azureFile: {
      accountName: sa.name
      accountKey: sa.listKeys().keys[0].value
      shareName: pgShareName
      // ReadWrite for Postgres. ACA SMB mount is best-effort — see the
      // Plan B note in plan.md if we hit corruption.
      accessMode: 'ReadWrite'
    }
  }
}

output environmentId string = env.id
output environmentName string = env.name
output defaultDomain string = env.properties.defaultDomain
