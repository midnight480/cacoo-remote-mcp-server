# Cacoo API keys and account configuration

Applies to: Cloudflare / AWS / Google Cloud / Azure

Issue a Cacoo API key and assemble `CACOO_ACCOUNTS_CONFIG`. One server can serve
several accounts.

## Issuing an API key

A Cacoo API key belongs to **a user, not a space**. The key can reach every
organization the signed-in account belongs to.

1. Sign in to Cacoo
2. Open [https://cacoo.com/profile/api](https://cacoo.com/profile/api)
3. Click **Create API key**
4. Copy the generated key

## Finding your organizationKey

Cacoo groups work into **organizations**, and the diagram and folder endpoints need an
`organizationKey` (except on legacy plans).

After deploying, call the `list_organizations` tool. It returns the organizations you
belong to; the `key` field is the `organizationKey`.

```json
[
  { "key": "abc123xyz", "name": "My Team", ... }
]
```

On a first deploy you cannot call tools yet, so it is fine to leave `organizationKey`
empty, deploy, run `list_organizations`, then update the configuration. Every tool also
accepts `organizationKey` as an argument, so the server works without a default.

## Assembling the configuration

```json
{
  "accounts": [
    {
      "name": "main",
      "apiKey": "API key of your personal account",
      "organizationKey": "abc123xyz"
    },
    {
      "name": "shared",
      "apiKey": "API key of a shared account",
      "organizationKey": "def456uvw",
      "readOnly": true
    }
  ],
  "defaultAccount": "main"
}
```

| Field | Required | Meaning |
|-------|:---:|---------|
| `name` | ✅ | A label of your choosing, used as the `account` argument on every tool. Case-insensitive |
| `apiKey` | | A shared API key embedded in the server config. **Omit it** to make the account per-user only (see [Per-user API keys and organizations](#per-user-api-keys-and-organizations)) |
| `organizationKey` | | Default organization for diagram and folder tools. Overridable per call. Not needed on legacy plans |
| `readOnly` | | `true` **rejects every non-GET call**, guarding a shared account against accidental writes |
| `baseUrl` | | Defaults to `https://cacoo.com`. Rarely needed |
| `defaultAccount` | ✅ | Account used when the `account` argument is omitted. Must match a `name` in `accounts` |

Set it as a single-line JSON string. Where it goes depends on the platform:

| Platform | Location |
|---|---|
| Cloudflare | `CACOO_ACCOUNTS_CONFIG` in `.dev.vars` |
| AWS | `CacooAccountsConfig` in `infra/aws/params.yaml` |
| Google Cloud | `cacoo_accounts_config` in `infra/gcp/terraform.tfvars` |
| Azure | `cacooAccountsConfig` in `infra/azure/params.json` |

```
CACOO_ACCOUNTS_CONFIG={"accounts":[{"name":"main","apiKey":"xxx","organizationKey":"abc123xyz"},{"name":"shared","apiKey":"yyy","readOnly":true}],"defaultAccount":"main"}
```

## When to use readOnly

The tools include destructive operations — `create_diagram`, `copy_diagram`,
`move_diagram`, `delete_diagram` — and the caller is an LLM. If a vague instruction
lands on the wrong account, `readOnly: true` is the last line of defence.

The check lives in the API-call layer of `src/core/cacoo-client.ts`, so it does not
depend on individual tool implementations and automatically covers tools added later.
A rejected call fails before any request reaches Cacoo.

```
Account "shared" is configured as read-only. Refusing POST diagrams/create.json.
Use list_accounts to see which accounts allow writes.
```

Cacoo's write endpoints are create, copy, move and delete — all POST. That is why a
single "reject anything that is not GET" rule covers them without gaps.

Use the `list_accounts` tool to see the state of each account.

## Per-user API keys and organizations

A key placed in `CACOO_ACCOUNTS_CONFIG` is a *shared* key: every caller acts as
whoever owns it. Diagrams get created by one system user, and Cacoo's own
permissions no longer distinguish your users from one another.

To make each caller act as themselves, **omit `apiKey` from the account** and have
the client send its own key with each request. The server never stores these keys
— they are read from the request, used for that one request, and discarded.

| Header | Purpose |
|---|---|
| `X-Cacoo-Api-Key` | One key, applied to `defaultAccount` |
| `X-Cacoo-Api-Keys` | Several keys, as `ACCOUNT=key` pairs separated by commas |
| `X-Cacoo-Org` | One organizationKey, applied to `defaultAccount` |
| `X-Cacoo-Orgs` | Several, as `ACCOUNT=organizationKey` pairs |

```
X-Cacoo-Api-Keys: WORK=your-work-key,TEAM=your-team-key
X-Cacoo-Orgs:     WORK=your-work-org,TEAM=your-team-org
```

Account names are matched case-insensitively. The organizationKey set this way is
the *default* for that account; the `organizationKey` argument on a tool call still
wins, so nothing about per-call overrides changes.

Where an account has both a shared value and a per-user one, the per-user one wins.
`list_accounts` reports which accounts currently have a usable key and where it came
from (`user`, `server`, or `missing`); it never reveals the key itself.

### Client configuration

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

**Codex** — `~/.codex/config.toml`. Use `env_http_headers` so the values come from
the environment rather than the file:

```toml
[mcp_servers.cacoo]
url = "https://mcp.example.com/mcp"
env_http_headers = { "X-Cacoo-Api-Keys" = "CACOO_API_KEYS", "X-Cacoo-Orgs" = "CACOO_ORGS" }
```

**Claude Desktop / Kiro / Cursor** via the `mcp-remote` proxy — write the header with
no space around the `:` and put the value in `env`:

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
        "CACOO_API_KEYS": "WORK=your-work-key",
        "CACOO_ORGS": "WORK=your-work-org"
      }
    }
  }
}
```

Prefer the environment-variable form over pasting keys into the file — these config
files tend to end up in Git.

Note that the header does not replace signing in. `/mcp` still sits behind the OAuth
flow, so the first connection opens a browser regardless. The two credentials answer
different questions: OAuth decides *who may use this server*, the header decides
*who you are to Cacoo*.

### Letting clients bring their own account

The setup above assumes an administrator registers every account. For a server where
each person connects their *own* Cacoo account, set `allowClientAccounts`:

```json
{
  "accounts": [],
  "allowClientAccounts": true
}
```

Any account name a client then sends is created on the fly:

```
X-Cacoo-Api-Keys: MINE=your-own-key
X-Cacoo-Orgs:     MINE=your-own-org
```

The name is just a label you pick — it is the `account` argument on tool calls. When
the config lists no account, the first one sent becomes the default.

**The destination host always comes from the server.** Clients choose a name and a
key, never a URL, so this cannot be used to make the server reach somewhere else.
With `allowClientAccounts` off, an unknown account name is an error rather than a
silent fall back to a shared key — a typo cannot make you write to Cacoo as someone else.

## Notes

- **An API key grants full access to Cacoo with its owner's permissions.**
  `readOnly: true` is a guard inside this MCP server; it does not restrict the key itself
- Cacoo API keys are **per user**, so you cannot scope a key to one organization. To
  forbid writes, either use `readOnly: true` or issue a key from a less privileged user
- Keys are secrets. They are stored in the platform's secret manager (Workers Secrets /
  Secrets Manager / Secret Manager / Key Vault) and never reach MCP clients
- If a key leaks, revoke it immediately at
  [https://cacoo.com/profile/api](https://cacoo.com/profile/api)

---

- Next: [Using Google as the IdP](idp-google.md) / [Using Microsoft Entra ID as the IdP](idp-entra-id.md)
- Deploy: [Cloudflare](deploy-cloudflare.md) / [AWS](deploy-aws.md) / [Google Cloud](deploy-gcp.md) / [Azure](deploy-azure.md)
