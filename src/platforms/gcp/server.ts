// platforms/gcp/server.ts
// Cloud Run のエントリポイント。
//
// 上流 IdP は既定で Google アカウント。UPSTREAM_IDP=entra を指定すれば
// Entra ID にも切り替えられる (他プラットフォームと同じ規約)。
//
// 機密値は Secret Manager から実行時に取得する。Cloud Run はコンテナ起動後に
// リクエストを受けるため、listen する前に解決しておく。

import { createApp } from "../../oauth/app";
import { resolveIdp } from "../../oauth/idp-presets";
import { McpOAuthProvider } from "../../oauth/provider";
import { portFrom, serve } from "../../oauth/serve";
import { createUpstreamClient } from "../../oauth/upstream";
import { SERVER_NAME } from "../../core/create-server";
import { FirestoreAuthStore } from "./store";
import { getSecret } from "./secrets";

function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Environment variable ${name} is required`);
	return v;
}

async function main(): Promise<void> {
	const issuerUrl = new URL(required("ISSUER_URL"));
	const projectId = process.env.GOOGLE_CLOUD_PROJECT;

	const [accountsConfig, upstreamClientSecret, cookieSecret] = await Promise.all([
		getSecret(required("CACOO_ACCOUNTS_SECRET"), projectId),
		getSecret(required("UPSTREAM_CLIENT_SECRET"), projectId),
		getSecret(required("COOKIE_SECRET"), projectId),
	]);

	const idp = resolveIdp(process.env, "google");

	const provider = new McpOAuthProvider({
		store: new FirestoreAuthStore(process.env.FIRESTORE_COLLECTION),
		allowedEmails: process.env.ALLOWED_EMAILS,
		cookieSecret,
		serverName: SERVER_NAME,
		upstream: createUpstreamClient({
			clientId: required("UPSTREAM_CLIENT_ID"),
			clientSecret: upstreamClientSecret,
			redirectUri: new URL("/callback", issuerUrl).toString(),
			...idp,
		}),
	});

	const app = createApp({
		provider,
		issuerUrl,
		accountsConfig,
		allowedEmails: process.env.ALLOWED_EMAILS,
	});

	serve(app, portFrom(process.env));
}

main().catch((e) => {
	console.error("failed to start:", e);
	process.exit(1);
});
