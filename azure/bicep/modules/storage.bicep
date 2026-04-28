@description('Region.')
param location string

@description('Tags.')
param tags object

@description('Storage account name (3-24 lowercase alphanumeric, globally unique).')
param storageAccountName string

@description('SMB file share name for Postgres data.')
param pgShareName string = 'pgdata'

@description('Quota in GiB for the pgdata share.')
@minValue(100)
param pgShareQuotaGiB int = 100

resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true // required for ACA managed-env storage link
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    largeFileSharesState: 'Enabled'
  }
}

resource fileServices 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: sa
  name: 'default'
  properties: {
    protocolSettings: {
      smb: {
        // Enforce strong auth/encryption for the agent-side SMB mount used
        // by ACA. ACA only supports SMB 3.1.1 with AES-256-GCM.
        versions: 'SMB3.1.1'
        authenticationMethods: 'NTLMv2;Kerberos'
        kerberosTicketEncryption: 'AES-256'
        channelEncryption: 'AES-256-GCM'
      }
    }
  }
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileServices
  name: pgShareName
  properties: {
    accessTier: 'TransactionOptimized'
    shareQuota: pgShareQuotaGiB
  }
}

output name string = sa.name
output resourceId string = sa.id
output pgShareName string = share.name
