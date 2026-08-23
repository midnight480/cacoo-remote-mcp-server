# Deploying to Google Cloud (Cloud Run)

Runs the Cacoo Remote MCP Server on Cloud Run, using a **Google account** as the
upstream IdP.

| Role | Service |
|---|---|
| Runtime | Cloud Run |
| OAuth state | Firestore |
| Secrets | Secret Manager |
| Upstream IdP | Google account (default) / Entra ID |
| IaC | Terraform |

Only those three things (runtime, state, secrets) differ from the AWS deployment.
The 158 MCP tools and the OAuth authorization server are shared through `src/core`
and `src/oauth`.

## Prerequisites

- A Google Cloud project with billing enabled
- The `gcloud` CLI, logged in
- Terraform 1.6 or later
- A Cacoo API key

## 1. Create an Artifact Registry repository

```bash
gcloud artifacts repositories create cacoo-mcp \
  --repository-format=docker \
  --location=asia-northeast1 \
  --project=<PROJECT_ID>
```

## 2. Create a Google OAuth client

Creating a Google OAuth client requires the console, so Terraform does not manage it.
Create an "OAuth client ID" on the
[credentials page](https://console.cloud.google.com/apis/credentials).

- Type: **Web application**
- Authorized redirect URI: `https://<your-domain>/callback`

**The redirect URI must match the URL you end up serving from.** If you are not using
a custom domain, deploy once, read the Cloud Run URL, then register it.

> To use Entra ID instead, see [Microsoft Entra ID setup](idp-entra-id.md) and set
> `upstream_idp = "entra"` plus `upstream_tenant_id` in `terraform.tfvars`.

## 3. Prepare terraform.tfvars

```bash
cp infra/gcp/terraform.tfvars.example infra/gcp/terraform.tfvars
```

| Variable | Meaning |
|---|---|
| `project_id` | Target project |
| `image` | Artifact Registry image URI |
| `public_base_url` | Public URL, no trailing slash. Becomes the OAuth issuer |
| `custom_domain` | Custom domain. Empty means use the run.app URL |
| `allowed_emails` | JSON array of emails allowed to use the tools |
| `upstream_client_id` / `upstream_client_secret` | The OAuth client from step 2 |
| `cacoo_accounts_config` | Cacoo account configuration (JSON string) |

This file holds secrets and is already in `.gitignore`.

## 4. Deploy

```bash
npm run gcp:validate # check syntax and types against the provider schema
npm run gcp:plan     # show the diff without creating anything
npm run gcp:deploy   # push the image, then terraform apply
```

`gcp:validate` works without Google Cloud credentials. So does `gcp:plan` while no
state exists yet — it shows 21 resources to create.

`gcp:deploy` builds the image with Cloud Build, pushes it to Artifact Registry, and
runs `terraform apply`.

The default region is `asia-northeast1`. Precedence is the `--region` argument, then
`GOOGLE_CLOUD_REGION`, then the default — the same order as the AWS deploy. If the
region embedded in `image` disagrees with the target region, the deploy stops before
running.

```bash
npm run gcp:deploy -- --region asia-northeast1
```

## 5. Confirm the redirect URI

```bash
terraform -chdir=infra/gcp output
```

Check that `oauth_redirect_uri` matches what you registered with Google in step 2.
If you use a custom domain, also create the DNS records shown in
`custom_domain_records`.

## 6. Connect

```bash
claude mcp add --transport http cacoo https://<your-domain>/mcp -s user
```

A browser opens on first connection and asks you to sign in with your Google account.

## Cost

With `min_instances = 0` Cloud Run costs nothing while idle, at the price of cold
starts. Set `min_instances = 1` to keep an instance warm, which you pay for.

- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Firestore pricing](https://cloud.google.com/firestore/pricing)
- [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing)

## Deleting

```bash
terraform -chdir=infra/gcp destroy
```

The Artifact Registry repository and the Google OAuth client are outside Terraform's
control and remain. Remove them manually.

## Troubleshooting

### It returns 401

That is expected. Unauthenticated requests get a 401 plus OAuth metadata. If
`/health` returns 200, the server itself is running.

### `tools/list` only shows access_denied

The email you signed in with is not in `allowed_emails`. Fix the Terraform variable
and re-apply.

### redirect_uri_mismatch

The redirect URI registered with Google does not match `public_base_url`. Register
the value of `terraform -chdir=infra/gcp output oauth_redirect_uri`.

### Firestore TTL looks like it is not working

Firestore TTL deletion can lag by up to 24 hours. The application also checks
`expiresAt` on read, so an expired token is never accepted.
