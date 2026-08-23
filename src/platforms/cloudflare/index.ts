// platforms/cloudflare/index.ts
// Cloudflare Workers 向けエントリポイント。
//
// このファイルの責務は「Workers 固有の配線」に限る:
//   - OAuthProvider (workers-oauth-provider) のセットアップ
//   - McpAgent (Durable Object) のライフサイクル
//   - env / props から設定値を取り出して core へ渡す
// ツールの実装と認可判定は src/core/create-server.ts にある。

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { registerTools, SERVER_NAME, SERVER_VERSION } from "../../core/create-server";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

export class CacooMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: SERVER_NAME,
		version: SERVER_VERSION,
	});

	async init() {
		registerTools(this.server, {
			accountsConfig: this.env.CACOO_ACCOUNTS_CONFIG,
			allowedEmails: this.env.ALLOWED_EMAILS,
			userEmail: this.props?.email,
		});
	}
}

// Export the OAuth provider as the default export
export default new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: CacooMCP.serve("/mcp"),
	defaultHandler: { fetch: handleAccessRequest as any },
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});
