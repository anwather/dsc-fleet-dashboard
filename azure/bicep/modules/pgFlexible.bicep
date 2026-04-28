// Azure Database for PostgreSQL Flexible Server, Burstable B1ms.
// ~$13/mo compute + ~$3/mo for 32 GiB storage. No SMB / chmod problems.
// Public access enabled with the AllowAllAzure firewall rule so the
// Container Apps env can reach it without VNet integration.

@description('PostgreSQL server name (3-63 lowercase alphanumeric or hyphen).')
param name string

param location string

@description('Administrator login (cannot be "azure_superuser", "admin", "administrator", "root", "guest", "public").')
param adminUser string = 'dscadmin'

@secure()
@description('Administrator password.')
param adminPassword string

@description('Initial database to create.')
param databaseName string = 'dscfleet'

@description('Postgres major version.')
param pgVersion string = '16'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: name
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: pgVersion
    administratorLogin: adminUser
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
  }
}

// Allow connections from any Azure service (includes Container Apps env).
// Acceptable for dev; for prod swap to private endpoint / VNet integration.
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output fqdn string = server.properties.fullyQualifiedDomainName
output serverName string = server.name
output databaseName string = databaseName
output adminUser string = adminUser
