// platforms/azure/store.ts
// AuthStore (src/oauth/store.ts) の Cosmos DB 実装。
//
// AWS 版の DynamoDB、GCP 版の Firestore に相当する層。単一コンテナに種別付きの
// id で格納し、Cosmos DB の TTL (ttl プロパティ、秒) で認可コード・トークンを
// 自動失効させる。TTL の削除は即時ではないため、読み出し時にも期限を検証する。
//
// パーティションキーは id をそのまま使う。レコードは独立しており、
// クロスパーティションのクエリを必要とする操作が無いため。

import { type Container, CosmosClient, type CosmosClientOptions } from "@azure/cosmos";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
	AuthCodeRecord,
	AuthStore,
	TokenRecord,
	UpstreamStateRecord,
} from "../../oauth/store";

const now = () => Math.floor(Date.now() / 1000);

/** クライアント登録の保持期間。DynamoDB / Firestore 版と同じ考え方。 */
const CLIENT_TTL_SEC = 60 * 60 * 24 * 90;
/** 書き込みを減らすため、残りがこの割合を切ったときだけ延長する */
const CLIENT_RENEW_THRESHOLD_SEC = CLIENT_TTL_SEC / 2;

export interface CosmosAuthStoreOptions {
	endpoint: string;
	databaseId?: string;
	containerId?: string;
	/** マネージド ID を使う場合に渡す。省略時はキー認証 (key 必須)。 */
	aadCredentials?: CosmosClientOptions["aadCredentials"];
	key?: string;
}

export class CosmosAuthStore implements AuthStore {
	private readonly container: Container;

	constructor(opts: CosmosAuthStoreOptions) {
		const client = new CosmosClient(
			opts.aadCredentials
				? { endpoint: opts.endpoint, aadCredentials: opts.aadCredentials }
				: { endpoint: opts.endpoint, key: opts.key },
		);
		this.container = client
			.database(opts.databaseId ?? "cacoo-mcp")
			.container(opts.containerId ?? "auth");
	}

	/** Cosmos DB の ttl は「作成/更新からの秒数」なので、絶対時刻から逆算する */
	private ttlFrom(expiresAt?: number): number | undefined {
		if (typeof expiresAt !== "number") return undefined;
		return Math.max(1, expiresAt - now());
	}

	private async put(id: string, data: Record<string, unknown>): Promise<void> {
		const ttl = this.ttlFrom(data.expiresAt as number | undefined);
		await this.container.items.upsert({ id, ...data, ...(ttl ? { ttl } : {}) });
	}

	private async get<T>(id: string): Promise<T | undefined> {
		try {
			const { resource } = await this.container.item(id, id).read<T & { expiresAt?: number }>();
			if (!resource) return undefined;
			// TTL の削除は即時ではないため、読み出し時にも期限を確認する
			if (typeof resource.expiresAt === "number" && resource.expiresAt <= now()) {
				return undefined;
			}
			return resource as T;
		} catch (e) {
			// 存在しない項目の read は 404 を投げる。undefined と同義に扱う。
			if ((e as { code?: number }).code === 404) return undefined;
			throw e;
		}
	}

	private async del(id: string): Promise<void> {
		try {
			await this.container.item(id, id).delete();
		} catch (e) {
			// TTL で先に消えている場合があるので 404 は無視する
			if ((e as { code?: number }).code !== 404) throw e;
		}
	}

	// --- 登録済みクライアント (動的クライアント登録) ---

	async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
		const rec = await this.get<{ client: OAuthClientInformationFull; expiresAt?: number }>(
			`client#${clientId}`,
		);
		if (!rec) return undefined;
		const remaining = (rec.expiresAt ?? 0) - now();
		if (remaining < CLIENT_RENEW_THRESHOLD_SEC) {
			await this.putClient(rec.client);
		}
		return rec.client;
	}

	async putClient(client: OAuthClientInformationFull): Promise<void> {
		await this.put(`client#${client.client_id}`, {
			client,
			expiresAt: now() + CLIENT_TTL_SEC,
		});
	}

	// --- 上流 IdP へのリダイレクト状態 ---

	async putUpstreamState(rec: UpstreamStateRecord): Promise<void> {
		await this.put(`ustate#${rec.state}`, { ...rec });
	}

	async takeUpstreamState(state: string): Promise<UpstreamStateRecord | undefined> {
		const rec = await this.get<UpstreamStateRecord>(`ustate#${state}`);
		if (rec) await this.del(`ustate#${state}`);
		return rec;
	}

	// --- 認可コード ---

	async putAuthCode(rec: AuthCodeRecord): Promise<void> {
		await this.put(`code#${rec.code}`, { ...rec });
	}

	async peekAuthCode(code: string): Promise<AuthCodeRecord | undefined> {
		return this.get<AuthCodeRecord>(`code#${code}`);
	}

	async takeAuthCode(code: string): Promise<AuthCodeRecord | undefined> {
		const rec = await this.peekAuthCode(code);
		if (rec) await this.del(`code#${code}`);
		return rec;
	}

	// --- アクセストークン / リフレッシュトークン ---

	async putToken(rec: TokenRecord): Promise<void> {
		await this.put(`token#${rec.token}`, { ...rec });
	}

	async getToken(token: string): Promise<TokenRecord | undefined> {
		return this.get<TokenRecord>(`token#${token}`);
	}

	async deleteToken(token: string): Promise<void> {
		await this.del(`token#${token}`);
	}
}
