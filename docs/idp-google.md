# Using Google Cloud as the Identity Provider

Applies to: both Cloudflare and AWS (the integration target differs)

Lets users sign in with a Google account. Creating the OAuth client is the same for
both platforms — **only the redirect URI you register differs**.

| Deployment | Authorized redirect URI |
|---|---|
| Cloudflare | `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/callback` |
| AWS | `https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/oauth2/idpresponse` |

You can register both on a single OAuth client and share it. Use separate clients if
you want to revoke them independently.

Use Google as the authentication provider via Cloudflare Access.

## Prerequisites

- A Google account (Gmail or Google Workspace)
- Admin access to your Cloudflare Zero Trust organization

## Step 2.1: Configure Google as an IdP in Cloudflare Zero Trust

1. Go to **Cloudflare Dashboard** → **Zero Trust** → **Settings** → **Authentication**
2. Under **Login methods**, click **Add new**
3. Select **Google**
4. You will see instructions to create OAuth credentials in Google Cloud Console

## Step 2.2: Create OAuth Credentials in Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select or create a project
3. Navigate to **APIs & Services** → **Credentials**
4. Click **Create Credentials** → **OAuth client ID**
5. Application type: **Web application**
6. Name: `Cloudflare Access`
7. Authorized redirect URIs: Add the URI shown in the Cloudflare Zero Trust setup page
   - Format: `https://<YOUR_TEAM_NAME>.cloudflareaccess.com/cdn-cgi/access/callback`
8. Click **Create**
9. Copy the **Client ID** and **Client Secret**

## Step 2.3: Complete Cloudflare Setup

1. Back in the Cloudflare Zero Trust Authentication page
2. Paste the Client ID and Client Secret from Google
3. Click **Save**
4. Test the connection by clicking **Test**

## Step 2.4: Configure OAuth Consent Screen (if needed)

If the test fails or you get a consent screen error:

1. Google Cloud Console → **APIs & Services** → **OAuth consent screen**
2. User Type: **External** (or Internal for Google Workspace)
3. Fill in app name, support email, and developer contact
4. Scopes: Add `email`, `profile`, `openid`
5. Test users: Add your email address (if External and not yet published)
6. Click **Save**

---

---

## Integrating with AWS (Cognito)

Add the Cognito redirect URI to the OAuth client created above:

```
https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/oauth2/idpresponse
```

`<COGNITO_DOMAIN_PREFIX>` is `CognitoDomainPrefix` in `infra/aws/params.yaml`. The
same value appears in the `GoogleRedirectUri` stack output after deployment.

Set the client ID and secret in `infra/aws/params.yaml`:

```yaml
GoogleClientId: '....apps.googleusercontent.com'
GoogleClientSecret: 'GOCSPX-....'
```

See [AWS deployment](deploy-aws.md) for details.

---

- Back: [Cacoo configuration](cacoo.md)
- Deploy: [Cloudflare Workers](deploy-cloudflare.md) / [AWS](deploy-aws.md)
