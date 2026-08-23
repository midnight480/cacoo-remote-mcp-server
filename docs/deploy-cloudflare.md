# Deploying to Cloudflare Workers

Prerequisites: [Cacoo configuration](cacoo.md) and one of
[Google](idp-google.md) or [Entra ID](idp-entra-id.md) as the IdP.

## Architecture

| Role | Component |
|---|---|
| Runtime | Cloudflare Workers |
| MCP session | Durable Objects (`McpAgent`) |
| OAuth authorization server | `@cloudflare/workers-oauth-provider` |
| Upstream IdP | Cloudflare Access (SaaS app / OIDC) |
| State storage | Workers KV |
| Secrets | Workers Secrets |
| Config file | `.dev.vars` |

## Step 4.1: Create Zero Trust Organization (if not done)

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Zero Trust** in the left sidebar
3. Follow the prompts to create a team name (e.g., `your-team`)
4. This gives you a `your-team.cloudflareaccess.com` domain

## Step 4.2: Create Access SaaS Application

1. Go to **Zero Trust** → **Access controls** → **Applications**
2. Click **Create new application** → **SaaS applications** tab → **OpenID Connect (OIDC)**
3. Configure:
   - Application name: `Cacoo MCP Server`
   - Authentication protocol: **OIDC** (not SAML)
4. Under **Redirect URLs**, add two entries:
   ```
   https://<MCP_HOSTNAME>/callback
   http://localhost:8788/callback
   ```
   The second is for local verification (`npm run check:local`). If Access rejects `http://`, use `npm run dev:https` and register `https://localhost:8788/callback` instead.
5. Turn **Proof Key for Code Exchange (PKCE)** **ON**

   The Worker always sends a `code_challenge` (S256), so this is required — token exchange fails without it.
   Leave the **Allow PKCE without Client Secret** toggle that appears below it **OFF** (the Worker is a confidential client and sends its client_secret).
6. Under **Identity providers**, enable the IdPs you configured (Google, Microsoft, or both)
7. (Optional) If only one IdP is enabled, turn on **Apply instant authentication** to skip the login method selection screen

## Step 4.3: Configure Access Policies

1. In the same application setup, under **Policies**
2. Create a policy:
   - Name: `Allow me`
   - Action: **Allow**
   - Include rules:
     - **Emails**: `your-email@gmail.com`, `your-ms@company.com`
   - (Or use **Email domain**, **IdP groups**, etc.)
3. Click **Save**

## Step 4.4: Note the Endpoints

After creating the application, you will see:

| Field | Example Value |
|-------|--------------|
| Client ID | `abc123...` |
| Client Secret | `secret456...` |
| Token endpoint | `https://your-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/token` |
| Authorization endpoint | `https://your-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/authorization` |
| Key (JWKS) endpoint | `https://your-team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/jwks` |

These values map to the Worker secrets:

| Secret Name | Value From |
|-------------|-----------|
| `ACCESS_CLIENT_ID` | Client ID |
| `ACCESS_CLIENT_SECRET` | Client Secret |
| `ACCESS_TOKEN_URL` | Token endpoint |
| `ACCESS_AUTHORIZATION_URL` | Authorization endpoint |
| `ACCESS_JWKS_URL` | Key (JWKS) endpoint |

## Step 4.5: (Optional) Enable Refresh Tokens

Under **Advanced settings** → turn on **Refresh tokens** to reduce re-authentication frequency.

---

## Step 5.1: Create .dev.vars

All environment-specific values live in `.dev.vars`. This single file is read by both local development and deployment, and is listed in `.gitignore`.

```bash
cp .dev.vars.example .dev.vars
```

## Step 5.2: Create KV Namespace

```bash
npx wrangler kv namespace create cacoo-remote-mcp-server-OAUTH_KV
```

Set the returned `id` in `.dev.vars`:

```
OAUTH_KV_ID=0123456789abcdef0123456789abcdef
```

> **Warning**
> Do not share a namespace with another Worker. OAuth authorization codes, access tokens, and approved clients are stored here — sharing one mixes credentials between Workers. Even if a generically named `OAUTH_KV` namespace already exists, create a dedicated one prefixed with your project name.

You do not need to edit `wrangler.jsonc`. The value from `.dev.vars` is injected at deploy time.

## Step 5.3: Fill In .dev.vars

Enter the values from Step 4.4 and the account configuration from Section 1.

```
# Custom domain to deploy to
MCP_HOSTNAME=cacoo-remote-mcp-server.example.com

# KV namespace ID created in Step 5.2
OAUTH_KV_ID=0123456789abcdef0123456789abcdef

# Values from Step 4.4
ACCESS_CLIENT_ID=...
ACCESS_CLIENT_SECRET=...
ACCESS_TOKEN_URL=https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/token
ACCESS_AUTHORIZATION_URL=https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/authorization
ACCESS_JWKS_URL=https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/jwks

# Cookie encryption key
COOKIE_ENCRYPTION_KEY=<output of openssl rand -hex 32>

# Allowed email addresses (JSON array)
ALLOWED_EMAILS=["your-email@gmail.com","your-ms@company.com"]

# Cacoo accounts configuration (see Section 1)
CACOO_ACCOUNTS_CONFIG={"accounts":[...],"defaultAccount":"main"}
```

Generate the cookie encryption key with:

```bash
openssl rand -hex 32
```

> **Note**
> `ALLOWED_EMAILS` is a separate check from the Access Policy. An address must be in **both** or the tools stay unavailable — login succeeds but `tools/list` returns only the single `access_denied` tool.

## Step 5.4: Verify Locally (recommended)

You can exercise the whole path before deploying.

```bash
npm run dev          # leave running in one terminal
npm run check:local  # run in another terminal
```

`check:local` performs the following in order, opening a browser partway through so you can complete the Access login:

1. Fetch the Authorization Server metadata
2. Dynamic client registration
3. Approve in the browser → Access login
4. Token exchange with PKCE
5. `initialize` / `tools/list`
6. Call `get_account` and show the real response from Cacoo

If this passes, your Access configuration, PKCE setting, email allowlist, and Cacoo API keys are all correct.

## Step 5.5: Deploy

```bash
npm run cloudflare:deploy
```

This runs three steps in order:

1. Generate `wrangler.deploy.json` with `MCP_HOSTNAME` and `OAUTH_KV_ID` injected from `.dev.vars`
2. Upload the `.dev.vars` values as Worker secrets via `wrangler secret bulk`
3. `wrangler deploy`

> **Warning**
> `wrangler.jsonc` contains neither the custom domain nor the KV ID. A bare `npx wrangler deploy` attaches no custom domain and fails on the placeholder KV ID. Always use `npm run cloudflare:deploy`.

The Worker is deployed to:

```
https://<MCP_HOSTNAME>/mcp
```

### Related commands

| Command | What it does |
|---|---|
| `npm run cloudflare:deploy` | Generate config → upload secrets → deploy |
| `npm run cloudflare:deploy:dry-run` | Generate and validate only (no upload) |
| `npm run cloudflare:deploy:no-secrets` | Deploy without touching secrets |
| `npm run cloudflare:secrets:push` | Upload secrets only |
| `npm run cloudflare:secrets:dry-run` | Show which keys would be sent (values are never printed) |

You can still set secrets individually:

```bash
npx wrangler secret put ACCESS_CLIENT_SECRET
```

> **Note**
> `npm run cloudflare:deploy` **overwrites** production secrets with the values in `.dev.vars`. If you need different values locally and in production, switch to `cloudflare:deploy:no-secrets` for routine deploys and push secrets explicitly with `cloudflare:secrets:push`.

## Step 5.6: Verify the Deployment

1. Open `https://<MCP_HOSTNAME>/mcp` in a browser
2. You should be redirected to the Cloudflare Access login screen
3. Authenticate with your configured IdP
4. After successful login, the MCP endpoint returns a JSON response

## Step 5.7: Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector@latest
```

1. Enter `https://<MCP_HOSTNAME>/mcp` in the URL field
2. Click **OAuth Settings** → **Quick OAuth Flow**
3. Complete authentication
4. Click **Connect** → **List Tools** and confirm all tools appear

---


## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Missing id token" error on callback | Ensure the Access SaaS app protocol is set to **OIDC**, not SAML |
| "User not authorized" after login | Check both Access Policy emails AND `ALLOWED_EMAILS` secret |
| "Invalid state signature" | COOKIE_ENCRYPTION_KEY may have been changed. Clear browser cookies and retry |
| Tools not showing after connect | Check `CACOO_ACCOUNTS_CONFIG` JSON is valid. Check Worker logs with `wrangler tail` |
| Google "access_denied" error | Ensure OAuth consent screen is configured and your email is in test users (if not published) |
| Entra ID "AADSTS..." errors | Verify redirect URI matches exactly, admin consent is granted, and secret is not expired |
| Token exchange fails / `invalid_grant` | Check that **PKCE** is ON in the Access SaaS App (Step 4.2). The Worker always sends a `code_challenge` |
| `MCP_HOSTNAME is not set` / `OAUTH_KV_ID is not set` | The key is missing from `.dev.vars` or still holds a placeholder (Steps 5.2 / 5.3) |
| `Account "..." is configured as read-only` | That account has `readOnly: true`. Remove it from `CACOO_ACCOUNTS_CONFIG` if writes are needed |
| `Account "..." not found` | `defaultAccount` or the `account` argument does not match a `name` in `accounts`. Check with `list_accounts` |
| Deployed but no custom domain attached | You likely ran a bare `wrangler deploy`. Use `npm run cloudflare:deploy` |
| Cannot return to `/callback` locally | Add `http://localhost:8788/callback` to the Access SaaS App redirect URLs (Step 4.2) |

---

- Back: [README](../README.md)
- Other platform: [AWS](deploy-aws.md)
