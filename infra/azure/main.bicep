// Azure Container Apps で Cacoo Remote MCP Server を動かす。
//
// 認証は Microsoft Entra ID を上流 IdP として使う。Entra ID のアプリ登録は
// Bicep では作れないため、登録済みのクライアント ID / secret を受け取る。
//
//   az deployment group create -g <RG> -f infra/azure/main.bicep -p @infra/azure/params.json

targetScope = 'resourceGroup'

@description('リソース名の接頭辞')
param name string = 'cacoo-mcp'

@description('デプロイ先リージョン')
param location string = resourceGroup().location

@description('コンテナイメージ。例: myacr.azurecr.io/cacoo-mcp:latest')
param image string

@description('Azure Container Registry のログインサーバ。ACR を使わない場合は空')
param registryServer string = ''

@description('このサーバの公開 URL (末尾スラッシュなし)。OAuth の issuer になる')
param publicBaseUrl string

@description('ツールの利用を許可するメールアドレスの JSON 配列')
param allowedEmails string = '[]'

@description('上流 IdP。entra または google')
@allowed([ 'entra', 'google' ])
param upstreamIdp string = 'entra'

@description('上流 IdP の OAuth クライアント ID (Entra ID のアプリケーション ID)')
param upstreamClientId string

@description('上流 IdP の OAuth クライアント secret')
@secure()
param upstreamClientSecret string

@description('Entra ID のテナント ID。upstreamIdp=google のときは空でよい')
param upstreamTenantId string = subscription().tenantId

@description('CACOO_ACCOUNTS_CONFIG の JSON 文字列')
@secure()
param cacooAccountsConfig string

@description('同意画面の Cookie 署名鍵。空なら生成する')
@secure()
param cookieSecret string = newGuid()

@description('コンテナの最小レプリカ数。0 なら未使用時は課金されない')
param minReplicas int = 0

@description('コンテナの最大レプリカ数')
param maxReplicas int = 3

var cosmosAccountName = toLower('${name}-cosmos-${uniqueString(resourceGroup().id)}')
var keyVaultName = take(toLower('${name}kv${uniqueString(resourceGroup().id)}'), 24)
var databaseName = 'cacoo-mcp'
var containerName = 'auth'

// --- ログ ---

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// --- Cosmos DB (OAuth の状態保存) ---

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: cosmosAccountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    // サーバーレスにしておくとリクエスト数に応じた課金になる
    capabilities: [ { name: 'EnableServerless' } ]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [ { locationName: location, failoverPriority: 0 } ]
    // 接続はマネージド ID で行うためキー認証を無効にする
    disableLocalAuth: true
  }
}

resource cosmosDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmos
  name: databaseName
  properties: {
    resource: { id: databaseName }
  }
}

resource cosmosContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: cosmosDb
  name: containerName
  properties: {
    resource: {
      id: containerName
      partitionKey: { paths: [ '/id' ], kind: 'Hash' }
      // ttl プロパティを持つ項目だけを失効させる (-1 = 既定では失効しない)
      defaultTtl: -1
    }
  }
}

// --- Key Vault (シークレット) ---

resource vault 'Microsoft.KeyVault/vaults@2024-04-01-preview' = {
  name: keyVaultName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    softDeleteRetentionInDays: 7
  }
}

resource cacooAccountsSecret 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = {
  parent: vault
  name: 'cacoo-accounts-config'
  properties: { value: cacooAccountsConfig }
}

resource upstreamSecret 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = {
  parent: vault
  name: 'upstream-client-secret'
  properties: { value: upstreamClientSecret }
}

resource cookieSecretRes 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = {
  parent: vault
  name: 'cookie-secret'
  properties: { value: cookieSecret }
}

// --- マネージド ID ---

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-identity'
  location: location
}

// Key Vault Secrets User
resource vaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, identity.id, '4633458b-17de-408a-b874-0445c86b69e6')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6'
    )
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Cosmos DB Built-in Data Contributor (データ面の RBAC は専用のロール定義を使う)
resource cosmosRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, identity.id, '00000000-0000-0000-0000-000000000002')
  properties: {
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    principalId: identity.properties.principalId
    scope: cosmos.id
  }
}

// --- Container Apps ---

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        // MCP クライアントは Azure の認証情報を持たないため外部公開する。
        // アクセス制御はアプリ内の OAuth と ALLOWED_EMAILS で行う。
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      registries: empty(registryServer) ? [] : [
        {
          server: registryServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'ISSUER_URL', value: publicBaseUrl }
            { name: 'ALLOWED_EMAILS', value: allowedEmails }
            { name: 'UPSTREAM_IDP', value: upstreamIdp }
            { name: 'UPSTREAM_CLIENT_ID', value: upstreamClientId }
            { name: 'UPSTREAM_TENANT_ID', value: upstreamTenantId }
            { name: 'KEY_VAULT_URL', value: vault.properties.vaultUri }
            { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
            { name: 'COSMOS_DATABASE', value: databaseName }
            { name: 'COSMOS_CONTAINER', value: containerName }
            // シークレットは名前だけ渡し、実行時に Key Vault から解決する
            { name: 'CACOO_ACCOUNTS_SECRET', value: cacooAccountsSecret.name }
            { name: 'UPSTREAM_CLIENT_SECRET', value: upstreamSecret.name }
            { name: 'COOKIE_SECRET', value: cookieSecretRes.name }
            // DefaultAzureCredential にどのマネージド ID を使うか教える
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/health', port: 8080 }
              initialDelaySeconds: 5
              periodSeconds: 5
              failureThreshold: 6
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
  dependsOn: [ vaultRole, cosmosRole, cosmosContainer ]
}

output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output mcpEndpoint string = '${publicBaseUrl}/mcp'
output oauthRedirectUri string = '${publicBaseUrl}/callback'
output keyVaultName string = vault.name
output cosmosAccount string = cosmos.name
output identityClientId string = identity.properties.clientId
