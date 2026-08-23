# Google Cloud を Identity Provider にする

対象: Cloudflare / AWS 共通 (連携先が異なる)

Google アカウントでログインできるようにします。OAuth クライアントの作成手順は
共通で、**リダイレクト URI の登録先だけがプラットフォームによって変わります**。

| デプロイ先 | 承認済みのリダイレクト URI |
|---|---|
| Cloudflare | `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/callback` |
| AWS | `https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/oauth2/idpresponse` |

1 つの OAuth クライアントに両方を登録して共用できます。個別に失効させたい場合は
クライアントを分けてください。

Cloudflare Access経由でGoogleを認証プロバイダーとして使用します。

## 前提条件

- Googleアカウント (GmailまたはGoogle Workspace)
- Cloudflare Zero Trust組織への管理者アクセス

## Step 2.1: Cloudflare Zero TrustでGoogleをIdPとして設定

1. **Cloudflare Dashboard** → **Zero Trust** → **Settings** → **Authentication**
2. **Login methods** の下で **Add new** をクリック
3. **Google** を選択
4. Google Cloud ConsoleでOAuth認証情報を作成する手順が表示されます

## Step 2.2: Google Cloud ConsoleでOAuth認証情報を作成

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. プロジェクトを選択または新規作成
3. **APIとサービス** → **認証情報** に移動
4. **認証情報を作成** → **OAuthクライアントID** をクリック
5. アプリケーションの種類: **ウェブアプリケーション**
6. 名前: `Cloudflare Access`
7. 承認済みのリダイレクトURI: Cloudflare Zero Trustの設定画面に表示されているURIを追加
   - 形式: `https://<YOUR_TEAM_NAME>.cloudflareaccess.com/cdn-cgi/access/callback`
8. **作成** をクリック
9. **クライアントID** と **クライアントシークレット** をコピー

## Step 2.3: Cloudflareの設定を完了

1. Cloudflare Zero Trust Authenticationのページに戻る
2. GoogleのクライアントIDとクライアントシークレットを貼り付け
3. **Save** をクリック
4. **Test** をクリックして接続をテスト

## Step 2.4: OAuth同意画面の設定 (必要な場合)

テストが失敗するか同意画面エラーが出た場合:

1. Google Cloud Console → **APIとサービス** → **OAuth同意画面**
2. ユーザータイプ: **外部** (Google Workspaceの場合は **内部**)
3. アプリ名、サポートメール、デベロッパー連絡先を入力
4. スコープ: `email`, `profile`, `openid` を追加
5. テストユーザー: 自分のメールアドレスを追加 (外部かつ未公開の場合)
6. **保存** をクリック

---

---

## AWS (Cognito) と連携する場合

上記で作成した OAuth クライアントに、Cognito のリダイレクト URI を追加します。

```
https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/oauth2/idpresponse
```

`<COGNITO_DOMAIN_PREFIX>` は `infra/aws/params.yaml` の `CognitoDomainPrefix` です。
デプロイ後に出力される `GoogleRedirectUri` にも同じ値が表示されます。

Client ID と Client Secret を `infra/aws/params.yaml` に設定します。

```yaml
GoogleClientId: '....apps.googleusercontent.com'
GoogleClientSecret: 'GOCSPX-....'
```

詳細は [AWS 版のデプロイ手順](deploy-aws_ja.md) を参照してください。

---

- 戻る: [Cacoo の設定](cacoo_ja.md)
- デプロイ: [Cloudflare Workers 版](deploy-cloudflare_ja.md) / [AWS 版](deploy-aws_ja.md)
