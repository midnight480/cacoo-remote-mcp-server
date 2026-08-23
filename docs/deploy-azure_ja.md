# Microsoft Azure (Container Apps) へのデプロイ

Azure Container Apps 上で Cacoo Remote MCP Server を動かします。認証は
**Microsoft Entra ID** を上流 IdP として使います。

| 役割 | サービス |
|---|---|
| 実行環境 | Container Apps |
| OAuth の状態保存 | Cosmos DB (サーバーレス) |
| シークレット | Key Vault |
| 上流 IdP | Microsoft Entra ID (既定) / Google アカウント |
| IaC | Bicep |

AWS / GCP 版との違いは、この 3 つ (実行環境・状態保存・シークレット) だけです。
158 個の MCP ツールと OAuth 認可サーバは `src/core` と `src/oauth` を共有しています。

**接続文字列やアクセスキーは一切使いません。** Cosmos DB はキー認証を無効化し
(`disableLocalAuth: true`)、Key Vault と合わせてユーザー割り当てマネージド ID の
RBAC で接続します。

## 必要なもの

- Azure サブスクリプション
- `az` CLI (ログイン済み)
- Azure Container Registry (ACR)
- Cacoo の API キー ([発行手順](cacoo_ja.md))

## 1. リソースグループと ACR を作る

```bash
az group create --name rg-cacoo-mcp --location japaneast
az acr create --resource-group rg-cacoo-mcp --name <ACR名> --sku Basic
```

## 2. Entra ID にアプリを登録する

Entra ID のアプリ登録は Bicep では作れないため、先に作成します。
詳細は [Microsoft Entra ID の設定](idp-entra-id_ja.md) を参照してください。

```bash
az ad app create --display-name "Cacoo Remote MCP Server" \
  --web-redirect-uris "https://<あなたのドメイン>/callback"
```

クライアント secret を発行し、アプリケーション (クライアント) ID と合わせて控えます。

> Google アカウントを使いたい場合は [Google の設定](idp-google_ja.md) を参照し、
> `params.json` で `upstreamIdp` を `"google"` にしてください。

## 3. params.json を用意する

```bash
cp infra/azure/params.example.json infra/azure/params.json
```

| パラメータ | 内容 |
|---|---|
| `image` | ACR のイメージ URI |
| `registryServer` | ACR のログインサーバ (`<ACR名>.azurecr.io`) |
| `publicBaseUrl` | 公開 URL (末尾スラッシュなし)。OAuth の issuer になる |
| `allowedEmails` | ツール利用を許可するメールアドレスの JSON 配列 |
| `upstreamClientId` / `upstreamClientSecret` | 手順 2 で作ったアプリ登録 |
| `cacooAccountsConfig` | Cacoo のアカウント設定 (JSON 文字列) |

`upstreamTenantId` は省略すると現在のサブスクリプションのテナントを使います。
`cookieSecret` は省略すると生成されます。

このファイルは機密値を含むため `.gitignore` 済みです。

## 4. デプロイ

```bash
export AZURE_RESOURCE_GROUP=rg-cacoo-mcp

npm run azure:validate  # Bicep をコンパイルして構文と型を検証する
npm run azure:what-if   # 何も作らず差分だけ確認する
npm run azure:deploy    # ACR でイメージをビルドして push し、Bicep をデプロイ
```

`azure:validate` は Azure の認証情報が無くても動きます。`azure:what-if` は
サブスクリプションへの接続が要ります。

`azure:deploy` は `az acr build` でイメージを作るため、**ローカルに Docker が
なくても動きます**。

リージョンの既定は `japaneast` です。優先順位は `--location` 引数 >
`AZURE_LOCATION` 環境変数 > 既定値で、AWS / GCP 版と揃えてあります。
`image` と `registryServer` が食い違う場合は実行前に停止します。

```bash
npm run azure:deploy -- --group rg-cacoo-mcp --location japaneast
```

## 5. リダイレクト URI を確定させる

デプロイ後の出力に `oauthRedirectUri` が出ます。手順 2 で Entra ID に登録した
URI と一致していることを確認してください。カスタムドメインを使わない場合は、
`appUrl` に出る Container Apps の FQDN を登録し直します。

```bash
az deployment group show --resource-group rg-cacoo-mcp \
  --name main --query properties.outputs
```

## 6. 接続する

```bash
claude mcp add --transport http cacoo https://<あなたのドメイン>/mcp -s user
```

初回接続時にブラウザが開き、Microsoft アカウントでの認証を求められます。

## コスト

Container Apps は最小レプリカ 0 なら未使用時は課金されません (その代わり
コールドスタートが出ます)。Cosmos DB はサーバーレスにしてあるので、
リクエスト数に応じた課金になります。

- [Container Apps の料金](https://azure.microsoft.com/pricing/details/container-apps/)
- [Cosmos DB の料金](https://azure.microsoft.com/pricing/details/cosmos-db/)
- [Key Vault の料金](https://azure.microsoft.com/pricing/details/key-vault/)

## 削除

```bash
az group delete --name rg-cacoo-mcp --yes
```

Key Vault は論理削除が有効 (7 日) なので、同じ名前で作り直す場合は
`az keyvault purge` が必要です。Entra ID のアプリ登録はリソースグループ外
なので残ります。

## トラブルシューティング

### 401 が返る

正常です。OAuth 未認証のリクエストには 401 とメタデータを返します。
`/health` が 200 を返せばサーバ自体は動いています。

### Cosmos DB で 403 が返る

マネージド ID へのデータ面ロール割り当てが効いていません。Cosmos DB は
コントロールプレーンの RBAC とは別に `sqlRoleAssignments` が必要で、
Bicep ではこれを作成しています。反映に数分かかることがあります。

### Key Vault で 403 が返る

`AZURE_CLIENT_ID` が正しいマネージド ID を指しているか確認してください。
ユーザー割り当て ID を複数持つコンテナでは、これが無いと
`DefaultAzureCredential` がどれを使うか決められません。

### `tools/list` に access_denied しか出ない

ログインしたメールアドレスが `allowedEmails` に入っていません。
`params.json` を直して再デプロイしてください。

### Cosmos DB の TTL が効いていないように見える

コンテナの `defaultTtl` は -1 (既定では失効しない) にしてあり、`ttl` を持つ
項目だけが失効します。削除は即時ではないため、アプリ側は読み出し時にも
`expiresAt` を検証しています。
