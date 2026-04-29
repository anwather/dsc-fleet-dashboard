// Three Container Apps: postgres (internal TCP), api (external HTTP), web (external HTTP).
//
// All apps use the same UAMI for ACR pull. The api also uses the UAMI's
// federated Azure identity at runtime via DefaultAzureCredential to invoke
// Run-Command on lab VMs.
//
// Singleton constraint: api scheduler is in-process — keep maxReplicas: 1.
// postgres MUST be 1 replica (single-writer + Azure Files SMB mount).

@description('Region.')
param location string

@description('Tags.')
param tags object

@description('ACA managed environment resource id.')
param environmentId string

@description('ACA env default domain (used to compute FQDNs).')
param environmentDefaultDomain string

@description('Logical name of the env-level managed storage backing pgdata.')
param pgManagedStorageName string

@description('ACR login server (e.g. dscfleetdscacr.azurecr.io).')
param acrLoginServer string

@description('UAMI resource id (used for ACR pull + DefaultAzureCredential).')
param identityResourceId string

@description('UAMI client id (DefaultAzureCredential needs this when multiple managed identities are attached).')
param identityClientId string

@description('Container image tag to deploy (e.g. git short SHA, or `latest`).')
param imageTag string = 'latest'

@description('Postgres database user name.')
param pgUser string = 'dscfleet'

@description('Postgres database name.')
param pgDatabase string = 'dscfleet'

@description('Postgres password (random if omitted).')
@secure()
param pgPassword string

@description('RUNAS_MASTER_KEY for AES-256-GCM encryption of password run-as creds. Base64, 32 bytes. Empty disables password run-as.')
@secure()
param runAsMasterKey string = ''

@description('Azure subscription id where lab VMs live (passed to the API for Run-Command).')
param azureSubscriptionId string = subscription().subscriptionId

@description('Default poll interval (seconds) advertised to agents.')
param agentPollDefaultSeconds int = 60

@description('Postgres mode: "container" uses an in-env postgres container with Azure Files storage; "managed" uses Azure Database for PostgreSQL Flexible Server.')
@allowed([
  'container'
  'managed'
])
param postgresMode string = 'container'

@description('When postgresMode=managed, the FQDN of the flexible server (e.g. dscfleet-pg.postgres.database.azure.com).')
param managedPgHost string = ''

@description('When postgresMode=managed, the admin user.')
param managedPgUser string = ''

@description('Entra (Azure AD) tenant ID for dashboard auth.')
param entraTenantId string

@description('Entra app registration client ID (also the API audience).')
param entraApiClientId string

// -----------------------------------------------------------------------------
// Computed FQDNs (ACA assigns deterministic names)
// -----------------------------------------------------------------------------
var webFqdn = 'web.${environmentDefaultDomain}'
// Internal short-name DNS within the same env. Use plain http on port 80.
var dbHost = postgresMode == 'managed' ? managedPgHost : 'postgres'
var dbUser = postgresMode == 'managed' ? managedPgUser : pgUser
// sslmode=require is required for Azure flexible server; harmless for in-env pg.
var dbSslSuffix = postgresMode == 'managed' ? '&sslmode=require' : ''
var databaseUrl = 'postgresql://${dbUser}:${pgPassword}@${dbHost}:5432/${pgDatabase}?schema=public${dbSslSuffix}'

// -----------------------------------------------------------------------------
// Postgres (internal-only TCP, single replica, AzureFile-backed)
// Skipped when postgresMode == 'managed'.
// -----------------------------------------------------------------------------
resource postgres 'Microsoft.App/containerApps@2024-10-02-preview' = if (postgresMode == 'container') {
  name: 'postgres'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityResourceId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        transport: 'tcp'
        targetPort: 5432
        exposedPort: 5432
      }
      secrets: [
        { name: 'pg-password', value: pgPassword }
      ]
      // No registries needed — postgres image is on Docker Hub.
    }
    template: {
      containers: [
        {
          name: 'postgres'
          image: 'postgres:16-alpine'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'POSTGRES_USER', value: pgUser }
            { name: 'POSTGRES_DB', value: pgDatabase }
            { name: 'POSTGRES_PASSWORD', secretRef: 'pg-password' }
            // PGDATA in a subdir avoids initdb tripping on lost+found
            // and keeps Azure Files share root usable for backups later.
            { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' }
          ]
          volumeMounts: [
            {
              volumeName: 'pgdata-vol'
              mountPath: '/var/lib/postgresql/data'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              tcpSocket: { port: 5432 }
              initialDelaySeconds: 60
              periodSeconds: 30
              failureThreshold: 6
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'pgdata-vol'
          storageType: 'AzureFile'
          storageName: pgManagedStorageName
        }
      ]
    }
  }
}

// -----------------------------------------------------------------------------
// API (external HTTP, single replica due to in-process scheduler)
// -----------------------------------------------------------------------------
resource api 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: 'api'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityResourceId}': {}
    }
  }
  // Implicit dependency via databaseUrl, but make it explicit so postgres
  // is provisioned first — the API does `prisma migrate deploy` at startup.
  // (No-op when postgresMode == 'managed' — module-level ordering handles it.)
  dependsOn: postgresMode == 'container' ? [
    postgres
  ] : []
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        transport: 'auto'
        targetPort: 3000
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          identity: identityResourceId
        }
      ]
      secrets: [
        { name: 'database-url', value: databaseUrl }
        { name: 'runas-master-key', value: runAsMasterKey }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: '${acrLoginServer}/dsc-fleet/api:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'API_PORT', value: '3000' }
            { name: 'LOG_LEVEL', value: 'info' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'RUNAS_MASTER_KEY', secretRef: 'runas-master-key' }
            { name: 'PUBLIC_BASE_URL', value: 'https://${webFqdn}' }
            { name: 'AGENT_POLL_DEFAULT_SECONDS', value: string(agentPollDefaultSeconds) }
            { name: 'AZURE_SUBSCRIPTION_ID', value: azureSubscriptionId }
            // DefaultAzureCredential needs the client id when multiple
            // managed identities could be attached, so be explicit.
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'ENTRA_TENANT_ID', value: entraTenantId }
            { name: 'ENTRA_API_CLIENT_ID', value: entraApiClientId }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 3000 }
              initialDelaySeconds: 60
              periodSeconds: 30
              failureThreshold: 6
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 3000 }
              initialDelaySeconds: 10
              periodSeconds: 10
              failureThreshold: 6
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Web (external HTTP, nginx serving SPA + reverse-proxy to api)
// -----------------------------------------------------------------------------
resource web 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: 'web'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityResourceId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        transport: 'auto'
        targetPort: 80
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          identity: identityResourceId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: '${acrLoginServer}/dsc-fleet/web:${imageTag}'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/', port: 80 }
              initialDelaySeconds: 30
              periodSeconds: 30
              failureThreshold: 6
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output postgresName string = postgres.name
output apiFqdn string = api.properties.configuration.ingress.fqdn
output webFqdn string = web.properties.configuration.ingress.fqdn
