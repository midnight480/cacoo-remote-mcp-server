// platforms/aws/handler.ts
// Lambda のエントリポイント。
//
// 機密値は Secrets Manager から実行時に取得するため初期化が非同期になる。
// CJS へバンドルするためトップレベル await は使えず、最初の呼び出し時に
// 初期化して以降は使い回す (実行環境が再利用される限り 1 回で済む)。

import serverlessExpress from "serverless-http";
import { SERVER_NAME } from "../../core/create-server";
import { createApp } from "../../oauth/app";
import { McpOAuthProvider } from "../../oauth/provider";
import { DynamoAuthStore } from "./store";
import { createUpstreamClient } from "../../oauth/upstream";
import { getSecret } from "./secrets";

function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Environment variable ${name} is required`);
	return v;
}

type ServerlessHandler = ReturnType<typeof serverlessExpress>;

async function build(): Promise<ServerlessHandler> {
	const issuerUrl = new URL(required("ISSUER_URL"));

	const [accountsConfig, upstreamClientSecret, cookieSecret] = await Promise.all([
		getSecret(required("CACOO_ACCOUNTS_SECRET_ARN")),
		getSecret(required("UPSTREAM_CLIENT_SECRET_ARN")),
		getSecret(required("COOKIE_SECRET_ARN")),
	]);

	const provider = new McpOAuthProvider({
		store: new DynamoAuthStore(required("AUTH_TABLE_NAME")),
		allowedEmails: process.env.ALLOWED_EMAILS,
		cookieSecret,
		serverName: SERVER_NAME,
		upstream: createUpstreamClient({
			domain: required("UPSTREAM_DOMAIN"),
			clientId: required("UPSTREAM_CLIENT_ID"),
			clientSecret: upstreamClientSecret,
			issuer: required("UPSTREAM_ISSUER"),
			redirectUri: new URL("/callback", issuerUrl).toString(),
		}),
	});

	const app = createApp({
		provider,
		issuerUrl,
		accountsConfig,
		allowedEmails: process.env.ALLOWED_EMAILS,
	});
	return serverlessExpress(app);
}

let cached: Promise<ServerlessHandler> | undefined;

export const handler = async (event: unknown, context: unknown) => {
	// 保留中のタイマーやソケットで実行が延びないようにする
	const ctx = context as { callbackWaitsForEmptyEventLoop?: boolean } | undefined;
	if (ctx) ctx.callbackWaitsForEmptyEventLoop = false;

	if (!cached) {
		cached = build().catch((e) => {
			// 初期化失敗をキャッシュに残さない (次の呼び出しで再試行できるように)
			cached = undefined;
			throw e;
		});
	}
	const fn = await cached;
	return (fn as (e: unknown, c: unknown) => unknown)(event, context);
};
