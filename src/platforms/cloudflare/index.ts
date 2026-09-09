// platforms/cloudflare/index.ts
// Cloudflare Workers 向けエントリポイント。
//
// このファイルの責務は「Workers 固有の配線」に限る:
//   - OAuthProvider (workers-oauth-provider) のセットアップ
//   - env / props / ヘッダから設定値を取り出して core へ渡す
// ツールの実装と認可判定は src/core/create-server.ts にある。
//
// なぜ Durable Object (McpAgent) を使わないか:
//   McpAgent はセッションごとに DO を持ち、init() で一度だけツールを登録する。
//   その際 props を ctx.storage へ書き込んで永続化するため、利用者本人の
//   Cacoo API キーを props 経由で渡すと DO のストレージに残ってしまう。
//   このサーバは Cacoo の資格情報を保存しない方針なので、リクエストごとに
//   サーバを組み立てる createMcpHandler を使う。現状の全ツールはリクエスト/
//   レスポンス型でサーバ発の push を使っておらず、セッション状態を必要としない。
//   結果として AWS / Google Cloud / Azure 版 (src/oauth/app.ts) と同じ形になる。
//
//   加えてセッション単位で固定されると、キーをローテートしても次のセッションまで
//   反映されない。リクエストごとに読む形ならその問題も起きない。

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { createMcpServer } from "../../core/create-server";
import {
	API_KEY_HEADER,
	API_KEYS_HEADER,
	InvalidCredentialError,
	ORG_HEADER,
	ORGS_HEADER,
	parseCredentialHeaders,
} from "../../core/credentials";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

const mcpHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// OAuthProvider は検証済みの認可情報を ctx.props に載せて渡してくる
		const props = ctx.props as Props | undefined;

		// 利用者本人のキーと組織はヘッダで運ばれてくる。
		// このサーバは保存せず、この 1 リクエストの間だけ設定に重ねて使う。
		let server: ReturnType<typeof createMcpServer>;
		try {
			server = createMcpServer({
				accountsConfig: env.CACOO_ACCOUNTS_CONFIG,
				allowedEmails: env.ALLOWED_EMAILS,
				userEmail: props?.email,
				userCredentials: parseCredentialHeaders({
					apiKey: request.headers.get(API_KEY_HEADER) ?? undefined,
					apiKeys: request.headers.get(API_KEYS_HEADER) ?? undefined,
					org: request.headers.get(ORG_HEADER) ?? undefined,
					orgs: request.headers.get(ORGS_HEADER) ?? undefined,
				}),
			});
		} catch (e) {
			// 設定ミスは利用者が直せるものなので、そのまま伝える。
			// キーの値は載せない (InvalidCredentialError は位置しか報告しない)。
			if (e instanceof InvalidCredentialError) {
				return Response.json(
					{ jsonrpc: "2.0", error: { code: -32602, message: e.message }, id: null },
					{ status: 400 },
				);
			}
			throw e;
		}

		try {
			return await createMcpHandler(server, {
				route: "/mcp",
				// sessionIdGenerator: undefined でステートレスモードになる。
				// 応答も SSE ではなく単発の JSON にする (src/oauth/app.ts と同じ理由)。
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			})(request, env, ctx);
		} finally {
			// リクエストごとに作ったサーバは明示的に閉じる。
			await server.close().catch(() => {});
		}
	},
};

// Export the OAuth provider as the default export
export default new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: mcpHandler,
	defaultHandler: { fetch: handleAccessRequest as any },
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});
