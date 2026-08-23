# Using Microsoft Entra ID as the Identity Provider

Applies to: both Cloudflare and AWS (the integration target differs)

Lets users sign in with a Microsoft work or school account.

| Deployment | Redirect URI |
|---|---|
| Cloudflare | `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/callback` |
| AWS | `https://<COGNITO_DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/oauth2/idpresponse` |

Use Microsoft Entra ID (formerly Azure AD) as the authentication provider via Cloudflare Access.

## Prerequisites

- A Microsoft account (personal or work/school)
- Admin access to your Cloudflare Zero Trust organization
- Access to [Microsoft Entra admin center](https://entra.microsoft.com/) (or Azure Portal)

## Step 3.1: Register an Application in Entra ID

1. Go to [Microsoft Entra admin center](https://entra.microsoft.com/)
2. Navigate to **Identity** → **Applications** → **App registrations**
3. Click **New registration**
4. Configure:
   - Name: `Cloudflare Access`
   - Supported account types: Choose based on your needs
     - **Single tenant**: Only your organization
     - **Multitenant + personal**: Any Microsoft account
   - Redirect URI:
     - Platform: **Web**
     - URI: `https://<YOUR_TEAM_NAME>.cloudflareaccess.com/cdn-cgi/access/callback`
5. Click **Register**
6. Note the **Application (client) ID** and **Directory (tenant) ID**

## Step 3.2: Create a Client Secret

1. In the registered app, go to **Certificates & secrets**
2. Click **New client secret**
3. Description: `Cloudflare Access`
4. Expiry: Choose an appropriate duration (recommended: 24 months)
5. Click **Add**
6. Copy the **Value** immediately (it will not be shown again)

## Step 3.3: Configure API Permissions

1. Go to **API permissions**
2. Click **Add a permission** → **Microsoft Graph** → **Delegated permissions**
3. Add these permissions:
   - `email`
   - `openid`
   - `profile`
   - `User.Read`
4. Click **Grant admin consent for [your org]** (if you have admin access)

## Step 3.4: Configure Cloudflare Zero Trust

1. Go to **Cloudflare Dashboard** → **Zero Trust** → **Settings** → **Authentication**
2. Under **Login methods**, click **Add new**
3. Select **Azure AD**
4. Fill in:
   - Application ID: The client ID from Step 3.1
   - Application secret: The client secret from Step 3.2
   - Directory ID: The tenant ID from Step 3.1
5. (Optional) Enable **Support Groups** if you want group-based access policies
6. Click **Save**
7. Test the connection by clicking **Test**

---

---

## Integrating with AWS (Cognito)

Cognito treats Entra ID as an OIDC provider. The current
`infra/aws/template.yaml` only ships a conditional resource for Google, so to use
Entra ID add an `AWS::Cognito::UserPoolIdentityProvider` with `ProviderType: OIDC`
and include it in `SupportedIdentityProviders`.

Take the values from your Entra ID app registration:

| Field | Source |
|---|---|
| client_id | Application (client) ID |
| client_secret | Certificates & secrets |
| oidc_issuer | `https://login.microsoftonline.com/<TENANT_ID>/v2.0` |
| authorize_scopes | `openid email profile` |

Always map both `email` and `email_verified`. Without `email_verified`, ID token
verification cannot tell whether the address is verified.

---

- Back: [Cacoo configuration](cacoo.md)
- Deploy: [Cloudflare Workers](deploy-cloudflare.md) / [AWS](deploy-aws.md)
