@description('Region.')
param location string

@description('Tags.')
param tags object

@description('Workspace name.')
param workspaceName string

resource ws 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    // PerGB2018 minimum retention is 30 days; daily quota cap keeps cost low.
    retentionInDays: 30
    workspaceCapping: {
      // 1 GiB/day cap to keep cost near zero for dev.
      dailyQuotaGb: 1
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

output workspaceId string = ws.id
output customerId string = ws.properties.customerId
@secure()
output primarySharedKey string = ws.listKeys().primarySharedKey
