// oauth/store.ts
// OAuth 認可サーバが必要とする永続化のインターフェース。
//
// 認可コード・トークン・上流 IdP へのリダイレクト状態を保持する。実装は
// プラットフォームごとに差し替える (AWS は DynamoDB、Cloudflare は KV、
// GCP なら Firestore、Azure なら Cosmos DB といった具合)。
//
// 期限切れの扱いは実装側の責務とする。TTL による自動削除は遅延しうるため、
// 読み出し時にも expiresAt を検証し、切れているものは undefined を返すこと。

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface AuthCodeRecord {
	code: string;
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	scopes: string[];
	userEmail: string;
	userId: string;
	resource?: string;
	/** epoch 秒 */
	expiresAt: number;
}

export interface TokenRecord {
	token: string;
	kind: "access" | "refresh";
	clientId: string;
	scopes: string[];
	userEmail: string;
	userId: string;
	resource?: string;
	/** epoch 秒 */
	expiresAt: number;
}

/** 上流 IdP へリダイレクトする間、MCP 側の認可要求を預けておくレコード */
export interface UpstreamStateRecord {
	state: string;
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	scopes: string[];
	mcpState?: string;
	resource?: string;
	/** 上流に対して使う PKCE の verifier */
	upstreamCodeVerifier: string;
	/** epoch 秒 */
	expiresAt: number;
}

export interface AuthStore {
	// --- 登録済みクライアント (動的クライアント登録) ---

	/**
	 * クライアント登録を取得する。
	 * 実装は取得のついでに保持期限を延長してよい (使われている登録を残すため)。
	 */
	getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
	putClient(client: OAuthClientInformationFull): Promise<void>;

	// --- 上流 IdP へのリダイレクト状態 ---

	putUpstreamState(rec: UpstreamStateRecord): Promise<void>;
	/** 一度しか使えない。取得と同時に削除すること。 */
	takeUpstreamState(state: string): Promise<UpstreamStateRecord | undefined>;

	// --- 認可コード ---

	putAuthCode(rec: AuthCodeRecord): Promise<void>;
	/** 削除せずに読むだけ。PKCE の challenge 参照に使う。 */
	peekAuthCode(code: string): Promise<AuthCodeRecord | undefined>;
	/** 認可コードは一度しか交換できない。取得と同時に削除すること。 */
	takeAuthCode(code: string): Promise<AuthCodeRecord | undefined>;

	// --- アクセストークン / リフレッシュトークン ---

	putToken(rec: TokenRecord): Promise<void>;
	getToken(token: string): Promise<TokenRecord | undefined>;
	deleteToken(token: string): Promise<void>;
}
