// platforms/azure/server.ts
// Azure Container Apps のエントリポイント。
//
// 上流 IdP は既定で Microsoft Entra ID。UPSTREAM_IDP=google を指定すれば
// Google アカウントにも切り替えられる (他プラットフォームと同じ規約)。
//
// 機密値は Key Vault から実行時に取得する。認証はマネージド ID
// (DefaultAzureCredential) なので、接続文字列を環境変数に置く必要はない。

import { DefaultAzureCredential } from "@azure/identity";
import { createApp } from "../../oauth/app";
import { resolveIdp } from "../../oauth/idp-presets";
import { McpOAuthProvider } from "../../oauth/provider";
import { portFrom, serve } from "../../oauth/serve";
import { createUpstreamClient } from "../../oauth/upstream";
import { SERVER_NAME } from "../../core/create-server";
import { CosmosAuthStore } from "./store";
import { getSecret } from "./secrets";

function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Environment variable ${name} is required`);
	return v;
}

async function main(): Promise<void> {
	const issuerUrl = new URL(required("ISSUER_URL"));
	const vaultUrl = required("KEY_VAULT_URL");

	const [accountsConfig, upstreamClientSecret, cookieSecret] = await Promise.all([
		getSecret(vaultUrl, required("CACOO_ACCOUNTS_SECRET")),
		getSecret(vaultUrl, required("UPSTREAM_CLIENT_SECRET")),
		getSecret(vaultUrl, required("COOKIE_SECRET")),
	]);

	// 既定は Entra ID。テナント ID はアプリ登録と同じものを使う。
	const idp = resolveIdp(process.env, "entra");

	const store = new CosmosAuthStore({
		endpoint: required("COSMOS_ENDPOINT"),
		databaseId: process.env.COSMOS_DATABASE,
		containerId: process.env.COSMOS_CONTAINER,
		// キーではなくマネージド ID で接続する
		aadCredentials: new DefaultAzureCredential(),
	});

	const provider = new McpOAuthProvider({
		store,
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
