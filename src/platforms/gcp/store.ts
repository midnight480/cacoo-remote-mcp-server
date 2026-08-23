// platforms/gcp/store.ts
// AuthStore (src/oauth/store.ts) の Firestore 実装。
//
// AWS 版の DynamoDB に相当する層。単一コレクションに種別付きのドキュメント ID で
// 格納し、expiresAt (Timestamp) を TTL フィールドにして認可コード・トークンを
// 自動失効させる。Firestore の TTL 削除は最大 24 時間遅れることがあるため、
// 読み出し時にも期限を検証する。

import { Firestore, type Settings, Timestamp } from "@google-cloud/firestore";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
	AuthCodeRecord,
	AuthStore,
	TokenRecord,
	UpstreamStateRecord,
} from "../../oauth/store";

const now = () => Math.floor(Date.now() / 1000);

/**
 * クライアント登録の保持期間。DynamoDB 版と同じ考え方。
 * /register は認証なしで叩けるため、期限を付けないと匿名のレコードが永久に溜まる。
 */
const CLIENT_TTL_SEC = 60 * 60 * 24 * 90;
/** 書き込みを減らすため、残りがこの割合を切ったときだけ延長する */
const CLIENT_RENEW_THRESHOLD_SEC = CLIENT_TTL_SEC / 2;

export class FirestoreAuthStore implements AuthStore {
	private readonly db: Firestore;

	constructor(
		private readonly collectionName = "cacoo-mcp-auth",
		settings?: Settings,
	) {
		this.db = new Firestore(settings);
	}

	private doc(id: string) {
		return this.db.collection(this.collectionName).doc(id);
	}

	private async put(id: string, data: Record<string, unknown>): Promise<void> {
		const expiresAt = data.expiresAt as number | undefined;
		await this.doc(id).set({
			...data,
			// TTL ポリシーは Timestamp 型のフィールドを見るため、epoch 秒とは別に持つ
			...(typeof expiresAt === "number"
				? { expireAt: Timestamp.fromMillis(expiresAt * 1000) }
				: {}),
		});
	}

	private async get<T>(id: string): Promise<T | undefined> {
		const snap = await this.doc(id).get();
		if (!snap.exists) return undefined;
		const item = snap.data() as (T & { expiresAt?: number }) | undefined;
		if (!item) return undefined;
		// TTL の削除は最大 24 時間遅れるため、読み出し時にも期限を確認する
		if (typeof item.expiresAt === "number" && item.expiresAt <= now()) return undefined;
		return item as T;
	}

	private async del(id: string): Promise<void> {
		await this.doc(id).delete();
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
