// cacoo-client.ts
// Cacoo API クライアント。複数アカウントの振り分けと readOnly ガードを持つ。
//
// Cacoo の REST API (https://developer.nulab.com/docs/cacoo/) は
//   - ベースパスが /api/v1
//   - 認証は apiKey をクエリパラメータで渡す
//   - リソースは .json / .png / .xml のサフィックスで表現する
//   - 参照は GET、作成・複製・移動・削除は POST
// という形。書き込みが POST に揃っているため、Backlog 版と同じ
// 「GET 以外を拒否する」ガードがそのまま成立する。

/** API のベース URL の既定値。宛先は常にサーバ側が決める。 */
export const DEFAULT_BASE_URL = "https://cacoo.com";

export interface CacooAccount {
	name: string;
	/**
	 * サーバ設定に埋め込んだ共有 API キー。
	 * 省略したアカウントは、利用者本人のキーが渡されたリクエストでのみ使える
	 * (src/core/credentials.ts)。サーバに資格情報を置きたくない構成向け。
	 */
	apiKey?: string;
	/**
	 * 既定の organizationKey。diagrams / folders 系はレガシープラン以外で必須。
	 * ツール側の引数で上書きできる。
	 */
	organizationKey?: string;
	/** このリクエストで使うキーの出所。applyUserCredentials が設定する */
	keySource?: "server" | "user";
	/** このリクエストで使う organizationKey の出所 */
	orgSource?: "server" | "user";
	/**
	 * true のアカウントでは書き込み系 API (GET 以外) を拒否する。
	 * 共用アカウントの図を誤って更新・削除しないためのガード。
	 */
	readOnly?: boolean;
	/** API のベース URL。既定は https://cacoo.com */
	baseUrl?: string;
}

/** 読み取り専用アカウントへの書き込みを拒否したときに投げるエラー */
export class ReadOnlyAccountError extends Error {
	constructor(account: CacooAccount, method: string, path: string) {
		super(
			`Account "${account.name}" is configured as read-only. ` +
				`Refusing ${method.toUpperCase()} ${path}. ` +
				`Use list_accounts to see which accounts allow writes.`,
		);
		this.name = "ReadOnlyAccountError";
	}
}

/** 読み取り専用アカウントなら書き込みを拒否する。全ての書き込み経路がここを通る。 */
function assertWritable(account: CacooAccount, method: string, path: string): void {
	if (account.readOnly && method.toUpperCase() !== "GET") {
		throw new ReadOnlyAccountError(account, method, path);
	}
}

/** そのアカウントに使えるキーが無いときに投げるエラー */
export class MissingCredentialError extends Error {
	constructor(account: CacooAccount) {
		super(
			`No Cacoo API key available for account "${account.name}". ` +
				`This server does not store credentials, so the key must come from your client: ` +
				`send it as the "X-Cacoo-Api-Key" header (single account) or ` +
				`"X-Cacoo-Api-Keys: ${account.name}=<your key>" (multiple accounts). ` +
				`Use list_accounts to see which accounts already have a key.`,
		);
		this.name = "MissingCredentialError";
	}
}

/** 実際に API 呼び出しへ渡すキーを取り出す。全ての呼び出し経路がここを通る。 */
export function requireApiKey(account: CacooAccount): string {
	if (!account.apiKey) throw new MissingCredentialError(account);
	return account.apiKey;
}

export interface CacooAccountsConfig {
	accounts: CacooAccount[];
	/**
	 * `account` を省略したときに使うアカウント名。
	 * クライアントがアカウントを持ち込む構成では設定側が空のこともある
	 * (その場合は最初に渡されたアカウントが既定になる)。
	 */
	defaultAccount: string;
	/**
	 * true のとき、設定に無いアカウント名でもクライアントが使える。
	 * 利用者が自分の Cacoo アカウントと組織を持ち込む構成向け。
	 */
	allowClientAccounts?: boolean;
}

export function parseAccountsConfig(configJson: string): CacooAccountsConfig {
	try {
		const config = JSON.parse(configJson) as CacooAccountsConfig;
		if (!config.accounts || !Array.isArray(config.accounts)) {
			throw new Error("CACOO_ACCOUNTS_CONFIG must have an accounts array");
		}
		config.allowClientAccounts = config.allowClientAccounts === true;
		// クライアントがアカウントを持ち込む構成でのみ、設定側を空にできる
		if (config.accounts.length === 0 && !config.allowClientAccounts) {
			throw new Error(
				"CACOO_ACCOUNTS_CONFIG must have at least one account, " +
					"or set allowClientAccounts to true so clients can bring their own",
			);
		}
		if (!config.defaultAccount) {
			// 空の設定では既定を決められない。渡されたアカウントから後で埋める。
			config.defaultAccount = config.accounts[0]?.name ?? "";
		}
		for (const account of config.accounts) {
			if (!account.name) {
				throw new Error("Account configuration invalid: each account needs a name");
			}
			// 明示的に true のときだけ書き込み禁止。未指定・不正値は書き込み可。
			account.readOnly = account.readOnly === true;
			account.baseUrl = (account.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		}
		return config;
	} catch (e) {
		if (e instanceof SyntaxError) {
			throw new Error("CACOO_ACCOUNTS_CONFIG is not valid JSON");
		}
		throw e;
	}
}

export function resolveAccount(
	config: CacooAccountsConfig,
	accountName?: string,
): CacooAccount {
	const targetName = accountName || config.defaultAccount;
	if (!targetName) {
		throw new Error(
			"No Cacoo account is available. This server has none configured, so your client " +
				'must send its own key with the "X-Cacoo-Api-Keys" header (NAME=key pairs).',
		);
	}
	const account = config.accounts.find(
		(a) => a.name.toLowerCase() === targetName.toLowerCase(),
	);
	if (!account) {
		const available = config.accounts.map((a) => a.name).join(", ");
		throw new Error(`Account "${targetName}" not found. Available accounts: ${available}`);
	}
	return account;
}

export type CacooQueryValue = string | number | boolean | undefined | null;

export interface CacooApiOptions {
	method?: "GET" | "POST";
	/** /api/v1 からの相対パス。例: "diagrams.json" */
	path: string;
	query?: Record<string, CacooQueryValue>;
	/**
	 * true のとき、query に organizationKey が無ければアカウントの既定値を補う。
	 * diagrams / folders 系のエンドポイントで使う。
	 */
	withOrganizationKey?: boolean;
}

/** Cacoo API のエラー応答 */
export class CacooApiError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		super(`Cacoo API request failed with status ${status}: ${body}`);
		this.name = "CacooApiError";
		this.status = status;
		this.body = body;
	}
}

/**
 * Cacoo のエラー本文を読める形に整える。
 * `{ "errors": [{ "message": "...", "code": 1, "moreInfo": "..." }] }` 形式で返る。
 */
export function formatCacooError(err: unknown): string {
	if (err instanceof CacooApiError) {
		try {
			const json = JSON.parse(err.body) as {
				errors?: { message?: string; code?: number; moreInfo?: string }[];
			};
			if (Array.isArray(json.errors) && json.errors.length > 0) {
				const detail = json.errors
					.map((e) => {
						const parts = [e.message ?? "Unknown error"];
						if (e.code !== undefined) parts.push(`code=${e.code}`);
						if (e.moreInfo) parts.push(e.moreInfo);
						return parts.join(" ");
					})
					.join("; ");
				return `Cacoo API error (HTTP ${err.status}): ${detail}`;
			}
		} catch {
			// JSON でなければそのまま出す
		}
		return `Cacoo API error (HTTP ${err.status}): ${err.body || err.message}`;
	}
	if (err instanceof Error) return err.message;
	return String(err);
}

function buildUrl(account: CacooAccount, options: CacooApiOptions): URL {
	const { path, query = {}, withOrganizationKey = false } = options;
	const url = new URL(`${account.baseUrl}/api/v1/${path.replace(/^\/+/, "")}`);
	url.searchParams.set("apiKey", requireApiKey(account));

	if (withOrganizationKey) {
		const orgKey = (query.organizationKey as string | undefined) ?? account.organizationKey;
		if (orgKey) url.searchParams.set("organizationKey", orgKey);
	}

	for (const [key, value] of Object.entries(query)) {
		if (key === "organizationKey" && withOrganizationKey) continue;
		if (value === undefined || value === null) continue;
		url.searchParams.set(key, String(value));
	}
	return url;
}

async function rawRequest(account: CacooAccount, options: CacooApiOptions): Promise<Response> {
	const method = options.method ?? "GET";
	assertWritable(account, method, options.path);

	const res = await fetch(buildUrl(account, options), {
		method,
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new CacooApiError(res.status, body);
	}
	return res;
}

/** JSON を返すエンドポイント用。本文が空なら空オブジェクトを返す。 */
export async function callCacooApi<T = unknown>(
	account: CacooAccount,
	options: CacooApiOptions,
): Promise<T> {
	const res = await rawRequest(account, options);
	const text = await res.text();
	if (text.length === 0) return {} as T;
	return JSON.parse(text) as T;
}

/** テキストを返すエンドポイント用 (contents.xml など)。 */
export async function callCacooApiText(
	account: CacooAccount,
	options: CacooApiOptions,
): Promise<string> {
	const res = await rawRequest(account, options);
	return res.text();
}

/** バイナリ応答の上限。Lambda / API Gateway の応答サイズ制限に収まるよう保守的に設定する。 */
export const MAX_BINARY_BYTES = 4 * 1024 * 1024;

export interface CacooBinary {
	base64: string;
	mimeType: string;
	/** 元のバイト数 (base64 化前) */
	size: number;
}

/** Uint8Array を base64 に変換する。Workers / Lambda 双方で動くよう btoa を使い、
 *  引数展開でスタックを溢れさせないためチャンク処理する。 */
function toBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/** 画像を返すエンドポイント用 (diagrams/<id>.png)。 */
export async function callCacooApiBinary(
	account: CacooAccount,
	options: CacooApiOptions,
): Promise<CacooBinary> {
	const res = await rawRequest(account, options);
	const buffer = await res.arrayBuffer();
	if (buffer.byteLength > MAX_BINARY_BYTES) {
		throw new Error(
			`Image is ${buffer.byteLength} bytes, which exceeds the ${MAX_BINARY_BYTES} byte limit ` +
				`for inline responses. Request a smaller width/height, or open it in Cacoo directly.`,
		);
	}
	return {
		base64: toBase64(new Uint8Array(buffer)),
		mimeType: res.headers.get("content-type") || "image/png",
		size: buffer.byteLength,
	};
}
