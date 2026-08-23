interface Env {
	// Durable Object
	MCP_OBJECT: DurableObjectNamespace;

	// KV
	OAUTH_KV: KVNamespace;

	// Cloudflare Access OAuth (SaaS app)
	ACCESS_CLIENT_ID: string;
	ACCESS_CLIENT_SECRET: string;
	ACCESS_TOKEN_URL: string;
	ACCESS_AUTHORIZATION_URL: string;
	ACCESS_JWKS_URL: string;
	COOKIE_ENCRYPTION_KEY: string;

	// Cacoo accounts configuration (JSON string)
	// Format: {"accounts": [{"name": "main", "apiKey": "xxx", "organizationKey": "org"}, ...], "defaultAccount": "main"}
	CACOO_ACCOUNTS_CONFIG: string;

	// Allowed email addresses (JSON array string)
	// Format: ["user@example.com"]
	ALLOWED_EMAILS: string;
}
