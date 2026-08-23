# Cacoo の API キーとアカウント設定

対象: Cloudflare / AWS / Google Cloud / Azure 共通

Cacoo の API キーを発行し、`CACOO_ACCOUNTS_CONFIG` を組み立てます。
複数のアカウントを 1 つのサーバから扱えます。

## API キーの発行

Cacoo の API キーは**スペース単位ではなくユーザー単位**です。ログインしている
アカウントが参加している組織すべてに、そのキーでアクセスできます。

1. Cacoo にログイン
2. [https://cacoo.com/profile/api](https://cacoo.com/profile/api) を開く
3. **API キーを作成** をクリック
4. 生成された API キーをコピー

## organizationKey を調べる

Cacoo には**組織 (organization)** という単位があり、図とフォルダを扱う API では
`organizationKey` が必要です（レガシープランを除く）。

デプロイ後に `list_organizations` ツールを呼ぶと、参加している組織が返ります。
その `key` フィールドが `organizationKey` です。

```json
[
  { "key": "abc123xyz", "name": "My Team", ... }
]
```

初回デプロイ時はまだツールを呼べないので、`organizationKey` を空のまま設定して
デプロイ → `list_organizations` で確認 → 設定を更新、という順でも構いません。
`organizationKey` は各ツールの引数でも指定できるため、既定値なしでも動きます。

## 設定の組み立て

```json
{
  "accounts": [
    {
      "name": "main",
      "apiKey": "個人アカウントの API キー",
      "organizationKey": "abc123xyz"
    },
    {
      "name": "shared",
      "apiKey": "共用アカウントの API キー",
      "organizationKey": "def456uvw",
      "readOnly": true
    }
  ],
  "defaultAccount": "main"
}
```

| フィールド | 必須 | 説明 |
|-----------|:---:|------|
| `name` | ✅ | 任意のラベル。MCP ツール呼び出し時の `account` パラメータとして使用。大文字小文字は区別されません |
| `apiKey` | ✅ | 上記で生成した API キー |
| `organizationKey` | | 図・フォルダ系ツールの既定の組織。ツール引数で上書きできます。レガシープランでは不要 |
| `readOnly` | | `true` で **GET 以外の API 呼び出しを拒否**。共用アカウントの誤更新・誤削除を防ぎます |
| `baseUrl` | | 既定は `https://cacoo.com`。通常は指定不要 |
| `defaultAccount` | ✅ | `account` パラメータ省略時に使うアカウント。`accounts` 内の `name` と一致させること |

この値は 1 行の JSON として設定します。設定先はプラットフォームごとに異なります。

| プラットフォーム | 設定先 |
|---|---|
| Cloudflare | `.dev.vars` の `CACOO_ACCOUNTS_CONFIG` |
| AWS | `infra/aws/params.yaml` の `CacooAccountsConfig` |
| Google Cloud | `infra/gcp/terraform.tfvars` の `cacoo_accounts_config` |
| Azure | `infra/azure/params.json` の `cacooAccountsConfig` |

```
CACOO_ACCOUNTS_CONFIG={"accounts":[{"name":"main","apiKey":"xxx","organizationKey":"abc123xyz"},{"name":"shared","apiKey":"yyy","readOnly":true}],"defaultAccount":"main"}
```

## readOnly の使いどころ

MCP ツールには `create_diagram` / `copy_diagram` / `move_diagram` / `delete_diagram`
といった破壊的操作が含まれ、呼び出す主体は LLM です。曖昧な指示が意図しない
アカウントに向いた場合、`readOnly: true` が最後の歯止めになります。

判定は `src/core/cacoo-client.ts` の API 呼び出し層で行われるため、個々のツール
実装に依存せず、将来ツールが追加されても自動的に保護されます。拒否された場合は
Cacoo API へリクエストを送る前にエラーが返ります。

```
Account "shared" is configured as read-only. Refusing POST diagrams/create.json.
Use list_accounts to see which accounts allow writes.
```

Cacoo の書き込み系 API は作成・複製・移動・削除の 4 つで、いずれも POST です。
そのため「GET 以外を拒否する」という単純な判定で漏れなく止められます。

各アカウントの状態は `list_accounts` ツールで確認できます。

## 注意事項

- **API キーはキー所有者の権限で Cacoo へのフルアクセスを許可します。** `readOnly: true`
  はこの MCP サーバー内のガードであり、キー自体の権限を制限するものではありません
- Cacoo の API キーは**ユーザー単位**です。組織ごとにキーを分けることはできないため、
  書き込みを禁じたい場合は `readOnly: true` を使うか、権限の弱いユーザーで別途キーを
  発行してください
- キーは機密情報です。各プラットフォームのシークレット管理 (Workers Secrets /
  Secrets Manager / Secret Manager / Key Vault) に格納され、MCP クライアントには
  一切露出しません
- キーが漏洩した場合は、[https://cacoo.com/profile/api](https://cacoo.com/profile/api)
  から即座に無効化してください

---

- 次: [Google Cloud を IdP にする](idp-google_ja.md) / [Microsoft Entra ID を IdP にする](idp-entra-id_ja.md)
- デプロイ: [Cloudflare](deploy-cloudflare_ja.md) / [AWS](deploy-aws_ja.md) / [Google Cloud](deploy-gcp_ja.md) / [Azure](deploy-azure_ja.md)
