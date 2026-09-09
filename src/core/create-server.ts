// create-server.ts
// プラットフォーム非依存の MCP サーバ組み立て。
//
// Cloudflare Workers / AWS Lambda など実行環境に依存する処理は一切含めない。
// 呼び出し側は「設定文字列3つ」を渡すだけでよく、アカウント設定の解析・
// メールアドレスによる認可判定・ツール登録はすべてここで完結する。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CacooAccountsConfig, parseAccountsConfig } from "./cacoo-client";
import { applyUserCredentials, type UserCredentials } from "./credentials";
import { registerDiagramTools } from "./tools/diagram-tools";
import { registerWorkspaceTools } from "./tools/workspace-tools";

export const SERVER_NAME = "Cacoo Remote MCP Server";
export const SERVER_VERSION = "1.0.0";

export interface CreateServerOptions {
	/** CACOO_ACCOUNTS_CONFIG の生の値 (JSON文字列) */
	accountsConfig: string;
	/** ALLOWED_EMAILS の生の値 (JSON配列文字列)。空なら許可リストなしとして全員通す */
	allowedEmails?: string;
	/** 認証済みユーザーのメールアドレス */
	userEmail?: string;
	/**
	 * 利用者本人の Cacoo API キーと organizationKey。
	 * リクエストごとにクライアントから運ばれてくるもので、サーバは保存しない。
	 * 指定されたアカウントでは設定側の共有キーより優先される。
	 *
	 * 配列を渡すと、優先度の低い順に並んでいるものとして扱う。
	 * 運搬経路が複数ある場合 (トークンの封筒とヘッダ) に、後のものを優先させる。
	 */
	userCredentials?: UserCredentials | UserCredentials[];
}

/** ALLOWED_EMAILS を小文字化した Set に変換する。不正なJSONは空集合として扱う。 */
export function parseAllowedEmails(raw?: string): Set<string> {
	try {
		const parsed = JSON.parse(raw || "[]");
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.map((e: string) => String(e).toLowerCase()));
	} catch {
		return new Set();
	}
}

/**
 * 許可リストが設定されており、かつユーザーがそこに含まれない場合に true。
 * 許可リストが空のときは制限なしとして扱う。
 */
export function isAccessDenied(allowedEmails: Set<string>, userEmail: string): boolean {
	return allowedEmails.size > 0 && !allowedEmails.has(userEmail);
}

/**
 * MCP サーバを組み立てて返す。
 * 認可されていないユーザーには access_denied ツールのみを登録する。
 */
export function createMcpServer(options: CreateServerOptions): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	registerTools(server, options);
	return server;
}

/**
 * 既存の McpServer インスタンスにツールを登録する。
 * server インスタンスを実行環境側が自前で保持する場合に使う。
 */
export function registerTools(server: McpServer, options: CreateServerOptions): void {
	const userEmail = (options.userEmail || "").toLowerCase();
	const allowedEmails = parseAllowedEmails(options.allowedEmails);

	if (isAccessDenied(allowedEmails, userEmail)) {
		server.tool("access_denied", "You are not authorized to use this server.", {}, async () => ({
			content: [{ type: "text", text: `Access denied. User ${userEmail} is not authorized.` }],
		}));
		return;
	}

	// 共有キーの上に本人のキーと組織を重ねる。以降のツールは出所を意識しない。
	const sources = Array.isArray(options.userCredentials)
		? options.userCredentials
		: options.userCredentials
			? [options.userCredentials]
			: [];
	const config: CacooAccountsConfig = applyUserCredentials(
		parseAccountsConfig(options.accountsConfig),
		...sources,
	);
	registerWorkspaceTools(server, config);
	registerDiagramTools(server, config);
}
