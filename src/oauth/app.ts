// oauth/app.ts
// OAuth 認可サーバと /mcp を載せた Express アプリ。
//
// MCP SDK の OAuth 認可サーバ実装 (mcpAuthRouter) が Express 前提のため
// Express で組む。認可サーバを自前実装すると PKCE・トークン交換・
// 動的クライアント登録まで自作することになり、correctness リスクが高い。
//
// Durable Object 相当の仕組みを前提にできないため MCP はステートレスで動かす。
// 現状の全ツールはリクエスト/レスポンス型でサーバ発の push を使っていない。
//
// Node が動く実行環境で共有する。実行環境固有の配線 (Lambda なら
// serverless-http、Cloud Run なら listen) は src/platforms/ 側の責務。

import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import express, { type Request, type Response } from "express";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "../core/create-server";
import {
	API_KEY_HEADER,
	API_KEYS_HEADER,
	InvalidCredentialError,
	ORG_HEADER,
	ORGS_HEADER,
	parseCredentialHeaders,
} from "../core/credentials";
import type { McpOAuthProvider } from "./provider";
import { toWebRequest, writeWebResponse } from "./web-bridge";

export interface AppConfig {
	provider: McpOAuthProvider;
	/** このサーバの公開 URL (issuer)。例: https://xxx.lambda-url.ap-northeast-1.on.aws */
	issuerUrl: URL;
	/** CACOO_ACCOUNTS_CONFIG の生の値 */
	accountsConfig: string;
	/** ALLOWED_EMAILS の生の値 */
	allowedEmails?: string;
}

export function createApp(config: AppConfig) {
	const app = express();
	// API Gateway が付ける X-Forwarded-For を信頼する。SDK の OAuth ハンドラは
	// express-rate-limit を使っており、未設定だと毎回 ValidationError を出す。
	// ホップ数を 1 に限定し、クライアントが XFF を偽装してレート制限を
	// 回避できないようにする。
	app.set("trust proxy", 1);
	app.use(express.json({ limit: "4mb" }));
	app.use(express.urlencoded({ extended: false }));

	app.get("/health", (_req, res) => {
		res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
	});

	// /authorize /token /register /revoke /.well-known/* を提供する
	app.use(
		mcpAuthRouter({
			provider: config.provider,
			issuerUrl: config.issuerUrl,
			resourceServerUrl: new URL("/mcp", config.issuerUrl),
			resourceName: SERVER_NAME,
			scopesSupported: ["openid"],
		}),
	);

	// 上流 IdP からのコールバック
	app.get("/callback", async (req: Request, res: Response) => {
		const { code, state, error, error_description } = req.query;
		if (typeof error === "string") {
			res
				.status(400)
				.json({ error, error_description: String(error_description ?? "") });
			return;
		}
		if (typeof code !== "string" || typeof state !== "string") {
			res.status(400).json({ error: "invalid_request", error_description: "Missing code or state" });
			return;
		}
		try {
			const redirectTo = await config.provider.handleUpstreamCallback(code, state);
			res.redirect(redirectTo);
		} catch (e) {
			console.error("callback failed:", e);
			res.status(400).json({
				error: "invalid_request",
				error_description: e instanceof Error ? e.message : "Callback failed",
			});
		}
	});

	const requireAuth = requireBearerAuth({ verifier: config.provider });

	app.all("/mcp", requireAuth, async (req: Request, res: Response) => {
		// requireBearerAuth が検証済みの情報を req.auth に載せる
		const userEmail = (req.auth?.extra?.userEmail as string | undefined) ?? "";

		// 利用者本人のキーと組織はヘッダで運ばれてくる。
		// このサーバは保存せず、この 1 リクエストの間だけ設定に重ねて使う。
		let server: ReturnType<typeof createMcpServer>;
		try {
			server = createMcpServer({
				accountsConfig: config.accountsConfig,
				allowedEmails: config.allowedEmails,
				userEmail,
				userCredentials: parseCredentialHeaders({
					apiKey: req.header(API_KEY_HEADER),
					apiKeys: req.header(API_KEYS_HEADER),
					org: req.header(ORG_HEADER),
					orgs: req.header(ORGS_HEADER),
				}),
			});
		} catch (e) {
			// 設定ミスは利用者が直せるものなので、そのまま伝える。
			// キーの値は載せない (InvalidCredentialError は位置しか報告しない)。
			if (e instanceof InvalidCredentialError) {
				res.status(400).json({
					jsonrpc: "2.0",
					error: { code: -32602, message: e.message },
					id: null,
				});
				return;
			}
			throw e;
		}

		const transport = new WebStandardStreamableHTTPServerTransport({
			// sessionIdGenerator: undefined でステートレスモードになる
			sessionIdGenerator: undefined,
			// 応答を SSE ではなく単発の JSON にする。
			// 既定 (false) では応答ごとに SSE ストリームを開くが、
			// ステートレス構成ではサーバ発の push が無いため利点がなく、
			// Lambda ではストリームの後始末が残って Runtime.NodeJsExit
			// (解決されない Promise) を招く。
			enableJsonResponse: true,
		});

		try {
			await server.connect(transport);
			const webReq = toWebRequest(req, config.issuerUrl.origin);
			const webRes = await transport.handleRequest(webReq);
			await writeWebResponse(res, webRes);
		} catch (e) {
			console.error("mcp request failed:", e);
			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: "2.0",
					error: { code: -32603, message: "Internal server error" },
					id: null,
				});
			}
		} finally {
			// レスポンスイベント (res の "close" など) に頼らず明示的に閉じる。
			// serverless-http が渡す擬似レスポンスでは発火しないことがあり、
			// transport / server の内部処理が保留のまま残って
			// Runtime.NodeJsExit を招く。
			// enableJsonResponse: true でボディは書き切られているため、
			// ここで閉じても応答は欠けない。
			await transport.close().catch(() => {});
			await server.close().catch(() => {});
		}
	});

	return app;
}
