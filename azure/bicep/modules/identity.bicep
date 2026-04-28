@description('Region.')
param location string

@description('Tags.')
param tags object

@description('UAMI name.')
param identityName string

@description('ACR name in the same RG.')
param acrName string

// Built-in role: AcrPull. See:
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#acrpull
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource id 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: acrName
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, id.id, acrPullRoleId)
  scope: acr
  properties: {
    principalId: id.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

output resourceId string = id.id
output principalId string = id.properties.principalId
output clientId string = id.properties.clientId
output name string = id.name
