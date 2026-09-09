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
| `apiKey` | | サーバ設定に埋め込む共有 API キー。**省略する**とそのアカウントは利用者本人のキー専用になります ([利用者ごとの API キーと組織](#利用者ごとの-api-キーと組織)) |
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

## 利用者ごとの API キーと組織

`CACOO_ACCOUNTS_CONFIG` に書いたキーは *共有キー* です。誰が操作しても、その
キーの持ち主として記録されます。図の作成者が全員同じシステムユーザーになり、
Cacoo 側の権限設定も利用者を区別できなくなります。

操作した本人として振る舞わせるには、**アカウントから `apiKey` を省略**し、
クライアントからリクエストごとに本人のキーを送ります。サーバはこのキーを
保存しません。リクエストから読み、その 1 回の処理に使い、破棄します。

| ヘッダ | 用途 |
|---|---|
| `X-Cacoo-Api-Key` | キー1つ。`defaultAccount` に適用されます |
| `X-Cacoo-Api-Keys` | 複数アカウント分。`アカウント名=キー` をカンマ区切り |
| `X-Cacoo-Org` | organizationKey を1つ。`defaultAccount` に適用されます |
| `X-Cacoo-Orgs` | 複数アカウント分。`アカウント名=organizationKey` をカンマ区切り |

```
X-Cacoo-Api-Keys: WORK=仕事用のキー,TEAM=チーム用のキー
X-Cacoo-Orgs:     WORK=仕事用の組織キー,TEAM=チーム用の組織キー
```

アカウント名の大文字小文字は区別しません。ここで指定した organizationKey は
そのアカウントの *既定値* で、ツール引数の `organizationKey` が優先される点は
従来どおりです。

共有の値と本人の値が両方ある場合は本人の値が優先されます。どのアカウントで
キーが使える状態か、その出所はどこか (`user` / `server` / `missing`) は
`list_accounts` で確認できます。キーの値そのものは返しません。

### クライアント側の設定

**Claude Code** — `.mcp.json`:

```json
{
  "mcpServers": {
    "cacoo": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Cacoo-Api-Keys": "${CACOO_API_KEYS}",
        "X-Cacoo-Orgs": "${CACOO_ORGS}"
      }
    }
  }
}
```

**Codex** — `~/.codex/config.toml`。値をファイルに書かずに環境変数から渡せる
`env_http_headers` を使います。

```toml
[mcp_servers.cacoo]
url = "https://mcp.example.com/mcp"
env_http_headers = { "X-Cacoo-Api-Keys" = "CACOO_API_KEYS", "X-Cacoo-Orgs" = "CACOO_ORGS" }
```

**Claude Desktop / Kiro / Cursor** (`mcp-remote` プロキシ経由) — `:` の前後に
空白を入れず、値は `env` に置きます。

```json
{
  "mcpServers": {
    "cacoo": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.example.com/mcp",
        "--header", "X-Cacoo-Api-Keys:${CACOO_API_KEYS}",
        "--header", "X-Cacoo-Orgs:${CACOO_ORGS}"
      ],
      "env": {
        "CACOO_API_KEYS": "WORK=仕事用のキー",
        "CACOO_ORGS": "WORK=仕事用の組織キー"
      }
    }
  }
}
```

いずれの場合も、キーを直接書かず環境変数を参照する形を勧めます。この種の設定
ファイルは Git に入りがちです。

なお、このヘッダはログインの代わりではありません。`/mcp` は従来どおり OAuth の
内側にあるので、初回接続時にはブラウザでの認可が走ります。2つの資格情報は別の
問いに答えるものです。OAuth が「このサーバを使ってよい人か」、ヘッダが
「Cacoo に対して誰であるか」です。

### クライアントにアカウントを持ち込ませる

ここまでは管理者が全アカウントを登録する前提でした。利用者がそれぞれ *自分の*
Cacoo アカウントを繋ぐサーバにする場合は、`allowClientAccounts` を有効にします。

```json
{
  "accounts": [],
  "allowClientAccounts": true
}
```

クライアントが送ってきたアカウント名は、その場で作られます。

```
X-Cacoo-Api-Keys: MINE=本人のキー
X-Cacoo-Orgs:     MINE=本人の組織キー
```

名前は利用者が決める単なるラベルで、ツール引数の `account` に使う値です。設定側が
空の場合は、最初に送られたものが既定になります。

**接続先ホストは常にサーバ側が決めます。** クライアントが指定できるのは名前とキーだけで
URL は渡せないため、サーバを別の宛先へ向かわせることはできません。
`allowClientAccounts` が無効なら、知らないアカウント名は共有キーへ黙って落ちずに
エラーになります。綴り間違いのせいで別人の権限で書き込む事故を防ぐためです。

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
