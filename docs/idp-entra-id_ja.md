# Microsoft Entra ID を Identity Provider にする

対象: Cloudflare / AWS 共通 (連携先が異なる)

Microsoft アカウント (職場・学校) でログインできるようにします。

| デプロイ先 | リダイレクト URI |
|---|---|
| Cloudflare | `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/callback` |
| AWS | `https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/oauth2/idpresponse` |

Cloudflare Access経由でMicrosoft Entra ID (旧 Azure AD) を認証プロバイダーとして使用します。

## 前提条件

- Microsoftアカウント (個人または職場/学校)
- Cloudflare Zero Trust組織への管理者アクセス
- [Microsoft Entra管理センター](https://entra.microsoft.com/) (またはAzure Portal) へのアクセス

## Step 3.1: Entra IDでアプリケーションを登録

1. [Microsoft Entra管理センター](https://entra.microsoft.com/) にアクセス
2. **ID** → **アプリケーション** → **アプリの登録** に移動
3. **新規登録** をクリック
4. 設定:
   - 名前: `Cloudflare Access`
   - サポートされているアカウントの種類: 用途に応じて選択
     - **この組織ディレクトリのみ**: 自分の組織だけ
     - **マルチテナント + 個人**: 任意のMicrosoftアカウント
   - リダイレクトURI:
     - プラットフォーム: **Web**
     - URI: `https://<YOUR_TEAM_NAME>.cloudflareaccess.com/cdn-cgi/access/callback`
5. **登録** をクリック
6. **アプリケーション (クライアント) ID** と **ディレクトリ (テナント) ID** を控える

## Step 3.2: クライアントシークレットの作成

1. 登録したアプリで **証明書とシークレット** を開く
2. **新しいクライアントシークレット** をクリック
3. 説明: `Cloudflare Access`
4. 有効期限: 適切な期間を選択 (推奨: 24ヶ月)
5. **追加** をクリック
6. **値** をすぐにコピー (後から表示できません)

## Step 3.3: APIアクセス許可の設定

1. **APIのアクセス許可** を開く
2. **アクセス許可の追加** → **Microsoft Graph** → **委任されたアクセス許可**
3. 以下の許可を追加:
   - `email`
   - `openid`
   - `profile`
   - `User.Read`
4. **[組織名] に管理者の同意を与えます** をクリック (管理者権限がある場合)

## Step 3.4: Cloudflare Zero Trustの設定

1. **Cloudflare Dashboard** → **Zero Trust** → **Settings** → **Authentication**
2. **Login methods** の下で **Add new** をクリック
3. **Azure AD** を選択
4. 入力:
   - Application ID: Step 3.1のクライアントID
   - Application secret: Step 3.2のクライアントシークレット
   - Directory ID: Step 3.1のテナントID
5. (任意) グループベースのアクセスポリシーを使いたい場合は **Support Groups** を有効化
6. **Save** をクリック
7. **Test** をクリックして接続をテスト

---

---

## AWS (Cognito) と連携する場合

Cognito では Entra ID を OIDC プロバイダとして追加します。現在の
`infra/aws/template.yaml` は Google のみを条件付きリソースとして持っているため、
Entra ID を使う場合は `AWS::Cognito::UserPoolIdentityProvider` を
`ProviderType: OIDC` で追加し、`SupportedIdentityProviders` に含めてください。

必要な値は Entra ID のアプリ登録から取得します。

| 項目 | 取得元 |
|---|---|
| client_id | アプリケーション (クライアント) ID |
| client_secret | 証明書とシークレット |
| oidc_issuer | `https://login.microsoftonline.com/<TENANT_ID>/v2.0` |
| authorize_scopes | `openid email profile` |

属性マッピングでは `email` と `email_verified` を必ず設定してください。
`email_verified` が無いと ID トークンの検証で検証済みか判別できなくなります。

---

- 戻る: [Cacoo の設定](cacoo_ja.md)
- デプロイ: [Cloudflare Workers 版](deploy-cloudflare_ja.md) / [AWS 版](deploy-aws_ja.md)
