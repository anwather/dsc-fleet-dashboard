@description('Region.')
param location string

@description('Tags.')
param tags object

@description('ACR name (3-50 lowercase alphanumeric, globally unique).')
param registryName string

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    // Anonymous pull off; only the UAMI (with acrpull) and authenticated
    // users can pull/push.
    anonymousPullEnabled: false
  }
}

output name string = acr.name
output resourceId string = acr.id
output loginServer string = acr.properties.loginServer
