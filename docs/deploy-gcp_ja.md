# Google Cloud (Cloud Run) へのデプロイ

Cloud Run 上で Cacoo Remote MCP Server を動かします。認証は **Google アカウント**
を上流 IdP として使います。

| 役割 | サービス |
|---|---|
| 実行環境 | Cloud Run |
| OAuth の状態保存 | Firestore |
| シークレット | Secret Manager |
| 上流 IdP | Google アカウント (既定) / Entra ID |
| IaC | Terraform |

AWS 版との違いは、この 3 つ (実行環境・状態保存・シークレット) だけです。
158 個の MCP ツールと OAuth 認可サーバは `src/core` と `src/oauth` を共有しています。

## 必要なもの

- Google Cloud プロジェクトと課金の有効化
- `gcloud` CLI (ログイン済み)
- Terraform 1.6 以上
- Cacoo の API キー ([発行手順](cacoo_ja.md))

## 1. Artifact Registry のリポジトリを作る

```bash
gcloud artifacts repositories create cacoo-mcp \
  --repository-format=docker \
  --location=asia-northeast1 \
  --project=<PROJECT_ID>
```

## 2. Google OAuth クライアントを作る

Google の OAuth クライアント作成はコンソール操作が必要なため、Terraform では
扱いません。[Google Cloud Console の認証情報ページ](https://console.cloud.google.com/apis/credentials)
で「OAuth クライアント ID」を作成します。

- 種類: **ウェブ アプリケーション**
- 承認済みのリダイレクト URI: `https://<あなたのドメイン>/callback`

**リダイレクト URI は後で確定する URL と一致させる必要があります。** カスタム
ドメインを使わない場合は、一度デプロイして Cloud Run の URL を確認してから
登録し直してください。

> Entra ID を使いたい場合は [Microsoft Entra ID の設定](idp-entra-id_ja.md) を
> 参照し、`terraform.tfvars` で `upstream_idp = "entra"` と `upstream_tenant_id`
> を設定してください。

## 3. terraform.tfvars を用意する

```bash
cp infra/gcp/terraform.tfvars.example infra/gcp/terraform.tfvars
```

| 変数 | 内容 |
|---|---|
| `project_id` | デプロイ先プロジェクト |
| `image` | Artifact Registry のイメージ URI |
| `public_base_url` | 公開 URL (末尾スラッシュなし)。OAuth の issuer になる |
| `custom_domain` | カスタムドメイン。空なら run.app の URL を使う |
| `allowed_emails` | ツール利用を許可するメールアドレスの JSON 配列 |
| `upstream_client_id` / `upstream_client_secret` | 手順 2 で作った OAuth クライアント |
| `cacoo_accounts_config` | Cacoo のアカウント設定 (JSON 文字列) |

このファイルは機密値を含むため `.gitignore` 済みです。

## 4. デプロイ

```bash
npm run gcp:validate # プロバイダのスキーマに対して構文と型を検証する
npm run gcp:plan     # 何も作らず差分だけ確認する
npm run gcp:deploy   # イメージを push して terraform apply
```

`gcp:validate` は Google Cloud の認証情報が無くても動きます。`gcp:plan` も
state がまだ無い状態なら認証情報なしで通ります (21 リソースの新規作成として
表示されます)。

`gcp:deploy` は Cloud Build でイメージを作って Artifact Registry へ push し、
その後 `terraform apply` を実行します。

リージョンの既定は `asia-northeast1` です。優先順位は `--region` 引数 >
`GOOGLE_CLOUD_REGION` 環境変数 > 既定値で、AWS 版と揃えてあります。
`image` の URI に含まれるリージョンとデプロイ先が食い違う場合は、
実行前に停止します。

```bash
npm run gcp:deploy -- --region asia-northeast1
```

## 5. リダイレクト URI を確定させる

```bash
terraform -chdir=infra/gcp output
```

`oauth_redirect_uri` の値が、手順 2 で Google に登録した URI と一致していることを
確認してください。カスタムドメインを使う場合は `custom_domain_records` に
表示される DNS レコードも設定します。

## 6. 接続する

```bash
claude mcp add --transport http cacoo https://<あなたのドメイン>/mcp -s user
```

初回接続時にブラウザが開き、Google アカウントでの認証を求められます。

## コスト

Cloud Run は最小インスタンス 0 なら未使用時は課金されません (その代わり
コールドスタートが出ます)。常時起動させたい場合は `min_instances = 1` に
しますが、その分の課金が発生します。

- [Cloud Run の料金](https://cloud.google.com/run/pricing)
- [Firestore の料金](https://cloud.google.com/firestore/pricing)
- [Secret Manager の料金](https://cloud.google.com/secret-manager/pricing)

## 削除

```bash
terraform -chdir=infra/gcp destroy
```

Artifact Registry のリポジトリと Google の OAuth クライアントは Terraform の
管理外なので残ります。手動で削除してください。

## トラブルシューティング

### 401 が返る

正常です。OAuth 未認証のリクエストには 401 とメタデータを返します。
`/health` が 200 を返せばサーバ自体は動いています。

### `tools/list` に access_denied しか出ない

ログインしたメールアドレスが `allowed_emails` に入っていません。
Terraform の変数を直して再適用してください。

### redirect_uri_mismatch

Google に登録したリダイレクト URI と `public_base_url` が食い違っています。
`terraform -chdir=infra/gcp output oauth_redirect_uri` の値を登録してください。

### Firestore の TTL が効いていないように見える

Firestore の TTL 削除は最大 24 時間遅れます。アプリ側は読み出し時にも
`expiresAt` を検証しているため、期限切れのトークンが使われることはありません。
