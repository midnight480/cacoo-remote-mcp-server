# Deploying to Microsoft Azure (Container Apps)

Runs the Cacoo Remote MCP Server on Azure Container Apps, using **Microsoft
Entra ID** as the upstream IdP.

| Role | Service |
|---|---|
| Runtime | Container Apps |
| OAuth state | Cosmos DB (serverless) |
| Secrets | Key Vault |
| Upstream IdP | Microsoft Entra ID (default) / Google account |
| IaC | Bicep |

Only those three things (runtime, state, secrets) differ from the AWS and Google
Cloud deployments. The 158 MCP tools and the OAuth authorization server are shared
through `src/core` and `src/oauth`.

**No connection strings or access keys are used.** Cosmos DB has key auth disabled
(`disableLocalAuth: true`); both it and Key Vault are reached through RBAC with a
user-assigned managed identity.

## Prerequisites

- An Azure subscription
- The `az` CLI, logged in
- An Azure Container Registry (ACR)
- A Cacoo API key

## 1. Create a resource group and ACR

```bash
az group create --name rg-cacoo-mcp --location japaneast
az acr create --resource-group rg-cacoo-mcp --name <ACR_NAME> --sku Basic
```

## 2. Register an application in Entra ID

Bicep cannot create Entra ID app registrations, so do this first. See
[Microsoft Entra ID setup](idp-entra-id.md) for details.

```bash
az ad app create --display-name "Cacoo Remote MCP Server" \
  --web-redirect-uris "https://<your-domain>/callback"
```

Create a client secret and note it along with the application (client) ID.

> To use a Google account instead, see [Google setup](idp-google.md) and set
> `upstreamIdp` to `"google"` in `params.json`.

## 3. Prepare params.json

```bash
cp infra/azure/params.example.json infra/azure/params.json
```

| Parameter | Meaning |
|---|---|
| `image` | ACR image URI |
| `registryServer` | ACR login server (`<ACR_NAME>.azurecr.io`) |
| `publicBaseUrl` | Public URL, no trailing slash. Becomes the OAuth issuer |
| `allowedEmails` | JSON array of emails allowed to use the tools |
| `upstreamClientId` / `upstreamClientSecret` | The app registration from step 2 |
| `cacooAccountsConfig` | Cacoo account configuration (JSON string) |

`upstreamTenantId` defaults to the current subscription's tenant. `cookieSecret` is
generated if omitted.

This file holds secrets and is already in `.gitignore`.

## 4. Deploy

```bash
export AZURE_RESOURCE_GROUP=rg-cacoo-mcp

npm run azure:validate  # compile the Bicep to check syntax and types
npm run azure:what-if   # show the diff without creating anything
npm run azure:deploy    # build and push the image with ACR, then deploy the Bicep
```

`azure:validate` works without Azure credentials. `azure:what-if` needs a live
subscription.

`azure:deploy` builds with `az acr build`, so **it works without Docker installed
locally**.

The default location is `japaneast`. Precedence is the `--location` argument, then
`AZURE_LOCATION`, then the default — the same order as the AWS and GCP deploys. If
`image` and `registryServer` disagree, the deploy stops before running.

```bash
npm run azure:deploy -- --group rg-cacoo-mcp --location japaneast
```

## 5. Confirm the redirect URI

The deployment outputs `oauthRedirectUri`. Check that it matches what you registered
with Entra ID in step 2. Without a custom domain, register the Container Apps FQDN
shown in `appUrl` instead.

```bash
az deployment group show --resource-group rg-cacoo-mcp \
  --name main --query properties.outputs
```

## 6. Connect

```bash
claude mcp add --transport http cacoo https://<your-domain>/mcp -s user
```

A browser opens on first connection and asks you to sign in with your Microsoft
account.

## Cost

With `minReplicas = 0` Container Apps costs nothing while idle, at the price of cold
starts. Cosmos DB is provisioned as serverless, so you pay per request.

- [Container Apps pricing](https://azure.microsoft.com/pricing/details/container-apps/)
- [Cosmos DB pricing](https://azure.microsoft.com/pricing/details/cosmos-db/)
- [Key Vault pricing](https://azure.microsoft.com/pricing/details/key-vault/)

## Deleting

```bash
az group delete --name rg-cacoo-mcp --yes
```

Key Vault soft delete is enabled (7 days), so reusing the same name requires
`az keyvault purge`. The Entra ID app registration lives outside the resource group
and remains.

## Troubleshooting

### It returns 401

That is expected. Unauthenticated requests get a 401 plus OAuth metadata. If
`/health` returns 200, the server itself is running.

### Cosmos DB returns 403

The data-plane role assignment for the managed identity has not taken effect. Cosmos
DB needs `sqlRoleAssignments` separately from control-plane RBAC; the Bicep creates
it, but propagation can take a few minutes.

### Key Vault returns 403

Check that `AZURE_CLIENT_ID` points at the right managed identity. Without it,
`DefaultAzureCredential` cannot choose between multiple user-assigned identities.

### `tools/list` only shows access_denied

The email you signed in with is not in `allowedEmails`. Fix `params.json` and
redeploy.

### Cosmos DB TTL looks like it is not working

The container's `defaultTtl` is -1, meaning nothing expires by default and only items
carrying a `ttl` do. Deletion is not immediate, so the application also checks
`expiresAt` on read.
