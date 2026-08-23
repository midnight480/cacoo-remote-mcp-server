# AWS へのデプロイ

前提: [Cacoo の設定](cacoo_ja.md) と、[Google](idp-google_ja.md) または
[Entra ID](idp-entra-id_ja.md) のいずれかの IdP 設定が済んでいること。

## 構成

| 役割 | 使うもの |
|---|---|
| 実行環境 | AWS Lambda (Node.js 22 / arm64) |
| 公開エンドポイント | API Gateway HTTP API |
| MCP セッション | 持たない (ステートレス) |
| OAuth 認可サーバ | MCP SDK の `mcpAuthRouter` (自前ホスト) |
| 上流 IdP | Amazon Cognito User Pool |
| 状態保存 | DynamoDB (TTL で自動失効。認可コード 5 分 / アクセストークン 1 時間 / リフレッシュトークン 30 日 / クライアント登録 90 日) |
| シークレット | AWS Secrets Manager |
| 同意画面の署名鍵 | Secrets Manager (CloudFormation が自動生成) |
| IaC | AWS SAM |
| 設定ファイル | `infra/aws/params.yaml` |

### Cloudflare 版との違い

- **Durable Objects に相当する仕組みがない**ため、MCP はステートレスで動かします。
  現状の全ツールはリクエスト/レスポンス型でサーバ発の push を使っていないため、
  機能上の欠落はありません。
- **Cognito は動的クライアント登録 (RFC 7591) に対応していません。** MCP クライアントは
  DCR を使うため Cognito を認可サーバにはできません。認可サーバは MCP SDK の実装を
  自前でホストし、Cognito は**ユーザー認証だけを担う上流 IdP** として置きます。
  これは Cloudflare 版で Cloudflare Access が担っている役割と同じです。
- **Lambda Function URL は使いません。** `WWW-Authenticate` ヘッダを
  `x-amzn-Remapped-www-authenticate` に書き換えてしまい、MCP クライアントの
  保護リソース探索 (RFC 9728) が働かなくなるためです。API Gateway HTTP API は
  このヘッダをそのまま通します。

## 認可の流れ

MCP クライアントから見た認可は次の順で進みます。

1. クライアントが `/register` で自身を動的登録する (RFC 7591)
2. クライアントが `/authorize` へユーザーを送る
3. **同意画面**でクライアント名とリダイレクト先を提示し、承認を求める
4. 承認後、Cognito のログイン画面へリダイレクト
5. ログイン完了後 `/callback` で ID トークンを検証し、`AllowedEmails` で判定
6. 認可コードを発行し、クライアントが `/token` で PKCE 交換
7. クライアントが `/mcp` をアクセストークン付きで呼ぶ

### 同意画面について

`/register` は仕様上、認証なしで誰でも呼べます。これは MCP クライアントが
事前設定なしに接続できるようにするための仕組みで、閉じると Claude Desktop や
mcp-remote が使えなくなります。

登録そのものに権限は伴いません。**実際の認可境界は上流 IdP での認証と
`AllowedEmails` の判定**です。ただし同意画面が無いと、攻撃者が自分の
リダイレクト先を持つクライアントを登録し、その認可 URL を許可済みユーザーに
踏ませることで認可コードを奪えます。攻撃者自身がフローを開始するため PKCE も
防御になりません。同意画面はこれを塞ぐためのものです。

承認は `client_id` + `redirect_uri` の組で `__Host-APPROVED_CLIENTS` Cookie に
記録し、2 回目以降は省略されます。リダイレクト先を差し替えて再登録しても、
過去の承認は引き継がれません。

署名鍵は CloudFormation が Secrets Manager に自動生成するため、運用者が
用意する必要はありません。

### クライアント登録の保持期間

登録レコードには 90 日の TTL を設定しています。認証なしで作成できるため、
期限が無いと匿名のレコードが溜まり続けるためです。使われているクライアントは
認可のたびに期限が延びるので、実際に消えるのは 90 日間まったく使われなかった
登録だけです。消えても MCP クライアントは動的登録で作り直せます。


## 前提ツール

```bash
aws --version    # AWS CLI v2
sam --version    # AWS SAM CLI
node --version   # Node.js 20 以上
```

AWS の認証情報が設定済みであること (`aws sts get-caller-identity` で確認)。

## 1. 設定ファイルの作成

```bash
cp infra/aws/params.example.yaml infra/aws/params.yaml
```

`infra/aws/params.yaml` は `.gitignore` 済みです。以降の手順で値を埋めます。

> **Note**
> `sam deploy --parameter-overrides` に値を直接書くと**カンマで分割されて JSON が壊れます**。
> 必ずこのファイル経由で渡してください。`npm run aws:deploy` はそうなっています。

## 2. 必須項目を記入

```yaml
# Cacoo アカウント設定 (1 行の JSON)。docs/cacoo_ja.md 参照
CacooAccountsConfig: '{"accounts":[...],"defaultAccount":"..."}'

# 許可するメールアドレス (JSON 配列)
AllowedEmails: '["your-email@example.com"]'

# Cognito Hosted UI のドメイン接頭辞 (グローバルに一意)
CognitoDomainPrefix: 'your-unique-prefix'

# 1 回目のデプロイでは placeholder のままにする
PublicBaseUrl: 'https://placeholder.invalid'
```

`CognitoDomainPrefix` は AWS 全体で一意である必要があります。プロジェクト名 +
ランダム文字列にしておくと衝突しません。

## 3. IdP (Google) を設定する場合

[Google Cloud の設定](idp-google_ja.md) で作成した OAuth クライアントの値を記入します。

```yaml
GoogleClientId: '....apps.googleusercontent.com'
GoogleClientSecret: 'GOCSPX-....'
```

**空のままでも構いません。** その場合 Google 連携は作られず、Cognito の内部ユーザー
のみになります。後から追加できます。

Google Cloud Console の「承認済みのリダイレクト URI」に以下を登録してください。

```
https://<CognitoDomainPrefix>.auth.<REGION>.amazoncognito.com/oauth2/idpresponse
```

## 4. カスタムドメイン (任意)

既定では API Gateway のエンドポイント (`https://xxxx.execute-api.<region>.amazonaws.com`)
を使います。独自ドメインを割り当てる場合、**DNS の管理先によって手順が変わります**。

### Route 53 にゾーンがある場合 (全自動)

ホストゾーン ID を入れるだけです。証明書の発行・DNS 検証・A レコード作成まで
CloudFormation が行います。

```yaml
ApiDomainName: 'cacoo-mcp.example.com'
HostedZoneId: 'Z0123456789ABCDEFGHIJ'
AcmCertificateArn: ''
```

### Route 53 以外で DNS を管理している場合 (Cloudflare など)

証明書を先に発行します。テンプレート内で作らないのは、Route 53 外だと
CloudFormation が DNS 検証の完了を待ち続けてスタックごと詰まるためです。

```bash
npm run aws:request-cert -- --domain cacoo-mcp.example.com
```

表示された CNAME を DNS に登録すると、検証完了まで待って ARN を出力します。
中断しても証明書は残り、再実行で続きから進みます。

```yaml
ApiDomainName: 'cacoo-mcp.example.com'
HostedZoneId: ''
AcmCertificateArn: 'arn:aws:acm:...'
```

デプロイ後、出力される `CustomDomainTarget` に向けて CNAME を登録します。

> **Warning**
> Cloudflare DNS の場合、**Proxy は必ず OFF (DNS only)** にしてください。
> ON にすると Cloudflare が TLS を終端し、API Gateway 側の証明書と噛み合いません。
> ACM の検証用レコードも同様です。

## 5. デプロイ

```bash
npm run aws:deploy
```

以下が順に行われます。

1. `sam build` (esbuild で CJS にバンドル)
2. `sam deploy` — Lambda / API Gateway / DynamoDB / Cognito / Secrets Manager を作成
3. Secrets Manager に `CacooAccountsConfig` と Cognito の client secret を登録

**シークレットはデプロイの過程で自動登録されます。** Lambda の環境変数には ARN しか
入りません (環境変数は `lambda:GetFunctionConfiguration` 権限があれば読めるため)。

### 2 回目のデプロイ

1 回目の出力に含まれるエンドポイントを `PublicBaseUrl` に設定して再デプロイします。
これで issuer と Cognito のコールバック URL が確定します。

```yaml
# カスタムドメインを使う場合はそちらを指定する
PublicBaseUrl: 'https://cacoo-mcp.example.com'
```

```bash
npm run aws:deploy
```

## 6. 動作確認

```bash
curl https://<PublicBaseUrl>/health
```

MCP エンドポイントまで含めた疎通確認は、Cloudflare 版と同じスクリプトが使えます。

```bash
npm run check:local -- --base https://<PublicBaseUrl>
```

ブラウザが開くのでログインを完了させると、`tools/list` と `get_account` まで確認します。

## コマンド一覧

| コマンド | 動作 |
|---|---|
| `npm run aws:validate` | テンプレートの検証 |
| `npm run aws:build` | ビルドのみ |
| `npm run aws:deploy` | ビルド + デプロイ + シークレット登録 |
| `npm run aws:secrets:push` | シークレットのみ更新 |
| `npm run aws:secrets:dry-run` | 送信されるシークレット名の確認 (値は非表示) |
| `npm run aws:request-cert` | ACM 証明書の発行と検証待ち |

## リージョン

既定は `ap-northeast-1` です。優先順位は `--region` 引数 > `AWS_REGION` 環境変数 >
既定値で、`aws:secrets:push` や `aws:request-cert` と揃えてあります。

```bash
npm run aws:deploy -- --region ap-northeast-1   # 明示する場合
AWS_REGION=ap-northeast-1 npm run aws:deploy    # 環境変数で指定する場合
```

**AWS プロファイルの既定リージョンは参照しません。** 以前は `sam deploy` に
`--region` が無く、プロファイルの既定 (例: `us-east-1`) へ向かって別リージョンに
二つ目のスタックを作るか、証明書のリージョン不一致で失敗する状態でした。

ACM 証明書はリージョンをまたいで参照できないため、デプロイ先と
`infra/aws/params.yaml` の `AcmCertificateArn` のリージョンが食い違う場合は
デプロイ前に停止します。

## スタック名を変える

既定は `cacoo-mcp-aws` です。変更する場合は `npm run aws:deploy -- --stack <name>`
を使うか、`scripts/aws-deploy.mjs` の既定値を書き換えてください。

**CloudFormation はスタック名を変更できません。** 名前を変えるとスタックの
作り直し (削除 → 再作成) になります。API Gateway のカスタムドメインも作り直されるため、
CNAME の向き先が変わる点に注意してください。

## 削除

```bash
sam delete --stack-name cacoo-mcp-aws --region ap-northeast-1
```

ACM 証明書はスタック外なので残ります。DNS レコードも手動で削除してください。

## トラブルシューティング

| 問題 | 解決策 |
|------|--------|
| `Unzipped size must be smaller than 262144000 bytes` | `sam deploy` に元テンプレートを渡しています。ビルド済みの `.aws-sam/build/template.yaml` を指定してください (`npm run aws:deploy` はそうなっています) |
| 環境変数に `{` だけが入る | `--parameter-overrides` に JSON を直接渡すとカンマで分割されます。`file://infra/aws/params.yaml` を使ってください |
| `Dynamic require of "http" is not supported` | ESM でバンドルされています。`Format: cjs` を確認してください |
| MCP が 406 `Client must accept both application/json and text/event-stream` | `serverless-http` の擬似 Node リクエストからヘッダが読めていません。`web-bridge.ts` 経由で Web 標準の Request を組み立てる実装になっているか確認してください |
| `invalid_client_secret` | Cognito アプリクライアントの secret が Lambda に渡っていません。Secrets Manager の `<stack>/upstream-client-secret` を確認してください |
| 同意画面が毎回出る | 承認は `__Host-APPROVED_CLIENTS` Cookie に記録されます。Cookie を消したか、MCP クライアントが毎回新しい `client_id` を動的登録している可能性があります |
| ログイン後に `access_denied` | `AllowedEmails` にそのアドレスが含まれていません |
| `redirect_uri_mismatch` (Google) | Google Cloud Console の承認済みリダイレクト URI に Cognito の `/oauth2/idpresponse` が登録されていません |
| `Account "..." is configured as read-only` | そのアカウントに `readOnly: true` が設定されています |
| カスタムドメインで TLS エラー | Cloudflare DNS の Proxy が ON になっていませんか。DNS only にしてください |
| CloudWatch に `Runtime.NodeJsExit` が出る | 既知の問題です。外部への `fetch` を行う経路 (`/callback` と Cacoo を呼ぶ `tools/call`) でのみ発生し、**応答自体は正常**です。Node 組み込み fetch (undici) の keep-alive ソケットが Lambda の凍結と噛み合わないことが原因と見ています。実害はログノイズのみのため未対応です |

---

- 戻る: [README](../README_ja.md)
- 別のプラットフォーム: [Cloudflare Workers 版](deploy-cloudflare_ja.md)
