# Cloudflare Workers へのデプロイ

前提: [Cacoo の設定](cacoo_ja.md) と、[Google](idp-google_ja.md) または
[Entra ID](idp-entra-id_ja.md) のいずれかの IdP 設定が済んでいること。

## 構成

| 役割 | 使うもの |
|---|---|
| 実行環境 | Cloudflare Workers |
| MCP セッション | Durable Objects (`McpAgent`) |
| OAuth 認可サーバ | `@cloudflare/workers-oauth-provider` |
| 上流 IdP | Cloudflare Access (SaaS アプリ / OIDC) |
| 状態保存 | Workers KV |
| シークレット | Workers Secrets |
| 設定ファイル | `.dev.vars` |

## Step 4.1: Zero Trust組織の作成 (未作成の場合)

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) にアクセス
2. 左サイドバーの **Zero Trust** をクリック
3. プロンプトに従ってチーム名を作成 (例: `your-team`)
4. これで `your-team.cloudflareaccess.com` ドメインが使えるようになります

## Step 4.2: Access SaaS Applicationの作成

1. **Zero Trust** → **Access controls** → **Applications**
2. **Create new application** → **SaaS applications** タブ → **OpenID Connect (OIDC)** を選択
3. 設定:
   - Application name: `Cacoo MCP Server`
   - Authentication protocol: **OIDC** (SAMLではない)
4. **Redirect URLs** に2つ追加:
   ```
   https://<MCP_HOSTNAME>/callback
   http://localhost:8788/callback
   ```
   下はローカル検証 (`npm run check:local`) 用です。Accessが `http://` を拒否する場合は `npm run dev:https` を使い `https://localhost:8788/callback` を登録してください。
5. **Proof Key for Code Exchange (PKCE)** を **ON** にする

   Workerは常に `code_challenge` (S256) を送るため必須です。OFFのままだとトークン交換が失敗します。
   その下に現れる **Allow PKCE without Client Secret** は **OFF** のままにしてください (Workerはclient_secretを送る機密クライアントです)。
6. **Identity providers** で設定済みのIdPを有効化 (Google、Microsoft、または両方)
7. (任意) IdPが1つだけの場合、**Apply instant authentication** をONにするとログイン選択画面をスキップ

## Step 4.3: Access Policyの設定

1. 同じアプリケーション設定画面の **Policies** セクション
2. ポリシーを作成:
   - Name: `Allow me`
   - Action: **Allow**
   - Include rules:
     - **Emails**: `your-email@gmail.com`, `your-ms@company.com`
   - (またはEmail domain、IdP groups等を使用)
3. **Save** をクリック

## Step 4.4: エンドポイント情報の確認

アプリケーション作成後、以下の値が表示されます:

| フィールド | 例 |
|-----------|-----|
| Client ID | `abc123...` |
| Client Secret | `secret456...` |
| Token endpoint | `https://your-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/token` |
| Authorization endpoint | `https://your-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/authorization` |
| Key (JWKS) endpoint | `https://your-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/jwks` |

Worker Secretsとの対応:

| Secret名 | 設定元 |
|----------|-------|
| `ACCESS_CLIENT_ID` | Client ID |
| `ACCESS_CLIENT_SECRET` | Client Secret |
| `ACCESS_TOKEN_URL` | Token endpoint |
| `ACCESS_AUTHORIZATION_URL` | Authorization endpoint |
| `ACCESS_JWKS_URL` | Key (JWKS) endpoint |

## Step 4.5: (任意) リフレッシュトークンの有効化

**Advanced settings** → **Refresh tokens** をONにすると再認証の頻度を減らせます。

---

## Step 5.1: .dev.vars の作成

環境固有の値はすべて `.dev.vars` に集約します。このファイルはローカル開発とデプロイの両方から参照され、`.gitignore` 済みです。

```bash
cp .dev.vars.example .dev.vars
```

## Step 5.2: KV Namespaceの作成

```bash
npx wrangler kv namespace create cacoo-remote-mcp-server-OAUTH_KV
```

出力された `id` を `.dev.vars` に設定します。

```
OAUTH_KV_ID=0123456789abcdef0123456789abcdef
```

> **Warning**
> 他のWorkerと共用のnamespaceを使わないでください。OAuthの認可コード・アクセストークン・承認済みクライアントがここに格納されます。共有すると別Workerと認証情報が混ざります。既に `OAUTH_KV` という汎用名のnamespaceがある場合も、プロジェクト名を接頭辞に付けた専用のものを新規作成してください。

`wrangler.jsonc` を編集する必要はありません。デプロイ時に `.dev.vars` の値が注入されます。

## Step 5.3: .dev.vars の記入

Step 4.4 で確認した値と、セクション1で作成したアカウント設定を書き込みます。

```
# デプロイ先のカスタムドメイン
MCP_HOSTNAME=cacoo-remote-mcp-server.example.com

# Step 5.2 で作成した KV namespace の ID
OAUTH_KV_ID=0123456789abcdef0123456789abcdef

# Step 4.4 の値
ACCESS_CLIENT_ID=...
ACCESS_CLIENT_SECRET=...
ACCESS_TOKEN_URL=https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/token
ACCESS_AUTHORIZATION_URL=https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/authorization
ACCESS_JWKS_URL=https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/jwks

# Cookie暗号化キー
COOKIE_ENCRYPTION_KEY=<openssl rand -hex 32 の出力>

# 許可メールアドレス (JSON配列)
ALLOWED_EMAILS=["your-email@gmail.com","your-ms@company.com"]

# Cacooアカウント設定 (セクション1参照)
CACOO_ACCOUNTS_CONFIG={"accounts":[...],"defaultAccount":"main"}
```

`COOKIE_ENCRYPTION_KEY` は以下で生成できます。

```bash
openssl rand -hex 32
```

> **Note**
> `ALLOWED_EMAILS` はAccess Policyとは別のチェックです。**両方**に同じアドレスが入っていないとツールが利用できません。片方だけだとログインは通るのに `access_denied` ツール1件しか返らない、という状態になります。

## Step 5.4: ローカルでの疎通確認 (推奨)

デプロイ前にローカルで全経路を確認できます。

```bash
npm run dev          # 別ターミナルで起動したままにする
npm run check:local  # 別ターミナルで実行
```

`check:local` は以下を順に実行し、途中でブラウザが開くのでAccessログインを完了させてください。

1. Authorization Serverメタデータの取得
2. 動的クライアント登録
3. ブラウザで承認 → Access ログイン
4. PKCEによるトークン交換
5. `initialize` / `tools/list`
6. `get_account` を実際に呼び出してCacooからの応答を確認

ここが通れば、Access設定・PKCE・メール許可・Cacoo APIキーがすべて正しいことになります。

## Step 5.5: デプロイ

```bash
npm run cloudflare:deploy
```

3ステップが順に実行されます。

1. `.dev.vars` の `MCP_HOSTNAME` と `OAUTH_KV_ID` を注入した `wrangler.deploy.json` を生成
2. `.dev.vars` の値を `wrangler secret bulk` でWorkerのシークレットとして登録
3. `wrangler deploy`

> **Warning**
> `wrangler.jsonc` にはカスタムドメインもKV IDも含まれていません。素の `npx wrangler deploy` はカスタムドメインが付かず、KV IDもプレースホルダのままで失敗します。必ず `npm run cloudflare:deploy` を使ってください。

Workerは以下にデプロイされます。

```
https://<MCP_HOSTNAME>/mcp
```

### 関連コマンド

| コマンド | 動作 |
|---|---|
| `npm run cloudflare:deploy` | 設定生成 → シークレット登録 → デプロイ |
| `npm run cloudflare:deploy:dry-run` | 設定生成と検証のみ (アップロードしない) |
| `npm run cloudflare:deploy:no-secrets` | シークレットに触れずデプロイのみ |
| `npm run cloudflare:secrets:push` | シークレット登録のみ |
| `npm run cloudflare:secrets:dry-run` | 送信されるキー名の確認のみ (値は表示されません) |

シークレットを個別に設定したい場合は従来の方法も使えます。

```bash
npx wrangler secret put ACCESS_CLIENT_SECRET
```

> **Note**
> `npm run cloudflare:deploy` は `.dev.vars` の値で本番のシークレットを**上書き**します。ローカルと本番で値を分けたくなった場合は、通常のデプロイに `cloudflare:deploy:no-secrets` を使い、シークレット更新は `cloudflare:secrets:push` で明示的に行う運用に切り替えてください。

## Step 5.6: 動作確認

1. ブラウザで `https://<MCP_HOSTNAME>/mcp` を開く
2. Cloudflare Accessのログイン画面にリダイレクトされるはず
3. 設定したIdPで認証
4. ログイン成功後、MCPエンドポイントからJSONレスポンスが返る

## Step 5.7: MCP Inspectorでテスト

```bash
npx @modelcontextprotocol/inspector@latest
```

1. URL欄に `https://<MCP_HOSTNAME>/mcp` を入力
2. **OAuth Settings** → **Quick OAuth Flow** をクリック
3. 認証を完了
4. **Connect** → **List Tools** をクリックし、全ツールが表示されることを確認

---


## トラブルシューティング

| 問題 | 解決策 |
|------|--------|
| コールバックで "Missing id token" エラー | Access SaaS Appのプロトコルが **OIDC** (SAMLではない) であることを確認 |
| ログイン後 "User not authorized" | Access Policyのメールアドレス **と** `ALLOWED_EMAILS` secretの両方を確認 |
| "Invalid state signature" | COOKIE_ENCRYPTION_KEYが変更された可能性。ブラウザCookieをクリアして再試行 |
| 接続後にツールが表示されない | `CACOO_ACCOUNTS_CONFIG` のJSONが有効か確認。`wrangler tail` でWorkerログを確認 |
| Google "access_denied" エラー | OAuth同意画面が設定されており、テストユーザーに自分のメールが含まれているか確認 (未公開の場合) |
| Entra ID "AADSTS..." エラー | リダイレクトURIが完全に一致すること、管理者の同意が付与されていること、シークレットが期限切れでないことを確認 |
| トークン交換が失敗する / `invalid_grant` | Access SaaS Appの **PKCE** がONか確認 (Step 4.2)。Workerは常に `code_challenge` を送ります |
| `MCP_HOSTNAME が未設定です` / `OAUTH_KV_ID が未設定です` | `.dev.vars` に該当キーがないか、プレースホルダのままです (Step 5.2 / 5.3) |
| `Account "..." is configured as read-only` | そのアカウントに `readOnly: true` が設定されています。書き込みが必要なら `CACOO_ACCOUNTS_CONFIG` から外してください |
| `Account "..." not found` | `defaultAccount` または `account` 引数が `accounts` 内の `name` と一致していません。`list_accounts` で確認できます |
| デプロイしたがカスタムドメインが付かない | 素の `wrangler deploy` を実行していませんか。`npm run cloudflare:deploy` を使ってください |
| ローカルで `/callback` に戻れない | Access SaaS Appのリダイレクトに `http://localhost:8788/callback` を追加してください (Step 4.2) |

---

- 戻る: [README](../README_ja.md)
- 別のプラットフォーム: [AWS 版](deploy-aws_ja.md)
