// credentials.ts
// 「利用者本人の Cacoo API キーと組織」をリクエストごとに受け取るための層。
//
// 設計方針:
//   このサーバは利用者の Cacoo 資格情報を一切永続化しない。キーはリクエスト
//   単位で運ばれてきて、そのリクエストの間だけ CacooAccountsConfig に重ねられ、
//   応答と共に捨てられる。保管場所はクライアント側 (JSON 設定やトークン) にある。
//
// 運搬経路は2つあり、どちらもここで同じ UserCredentials に正規化する:
//   1. HTTP ヘッダ   — JSON でサーバを設定できるクライアント (Claude Code / Codex / Kiro CLI)
//   2. トークン封筒  — ヘッダを指定できない GUI クライアント (Claude Desktop / claude.ai)
//
// Cacoo のアカウント名は単なるラベルで、Backlog のスペースのように接続先ホストを
// 決めるものではない。そのため allowClientAccounts が有効なら、設定に無い名前が
// 来た時点でそのアカウントを作ってよい。宛先は常に設定側の baseUrl なので、
// クライアントがサーバの接続先を動かすことはできない。
//
// この層が扱うのは「入力の解析と検証」だけで、HTTP そのものには触れない。
// 実行環境ごとの配線 (Express の req からヘッダを読む等) は呼び出し側の責務。

import {
	type CacooAccount,
	type CacooAccountsConfig,
	DEFAULT_BASE_URL,
	parseAccountsConfig,
} from "./cacoo-client";

/** アカウント名 (小文字) → その利用者自身の API キー */
export type UserApiKeys = Record<string, string>;
/** アカウント名 (小文字) → 既定として使う organizationKey */
export type UserOrgKeys = Record<string, string>;

/** 1つの運搬経路が運んできた資格情報 */
export interface UserCredentials {
	keys?: UserApiKeys;
	orgs?: UserOrgKeys;
}

/** 単一キー指定用のヘッダ。デフォルトアカウントに適用される */
export const API_KEY_HEADER = "x-cacoo-api-key";
/** 複数アカウント指定用のヘッダ。`WORK=xxx,TEAM=yyy` 形式 */
export const API_KEYS_HEADER = "x-cacoo-api-keys";
/** 単一の組織指定用のヘッダ。デフォルトアカウントに適用される */
export const ORG_HEADER = "x-cacoo-org";
/** 複数アカウントの組織指定用のヘッダ。`WORK=orgkey,TEAM=orgkey2` 形式 */
export const ORGS_HEADER = "x-cacoo-orgs";

/**
 * 単一指定ヘッダの置き場所を表す予約名。
 * 解析時点ではデフォルトアカウント名が分からないため、
 * applyUserCredentials で実際の名前へ解決する。
 */
export const DEFAULT_ACCOUNT_SENTINEL = "*";

/** キーの最大長。Cacoo の API キーは短いが余裕を持たせる */
const MAX_VALUE_LENGTH = 512;
/** アカウント名の最大長 */
const MAX_ACCOUNT_NAME_LENGTH = 128;

/** ヘッダやトークン封筒の中身が不正だったときに投げるエラー (利用者の設定ミス) */
export class InvalidCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidCredentialError";
	}
}

/**
 * 値として受け付ける文字。
 * 空白と制御文字とカンマ (区切り文字) を除く印字可能 ASCII に限る。
 * ログや URL に紛れ込んだときの事故を減らし、区切り解析を曖昧にしないため。
 */
function assertValidValue(value: string, where: string, label: string): void {
	if (value.length === 0) {
		throw new InvalidCredentialError(`${where}: ${label} is empty.`);
	}
	if (value.length > MAX_VALUE_LENGTH) {
		throw new InvalidCredentialError(
			`${where}: ${label} is too long (${value.length} > ${MAX_VALUE_LENGTH}).`,
		);
	}
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x20 || code >= 0x7f || value[i] === ",") {
			throw new InvalidCredentialError(
				`${where}: ${label} contains an unsupported character at position ${i}. ` +
					`Expected printable ASCII without spaces or commas.`,
			);
		}
	}
}

function assertValidAccountName(name: string, where: string): void {
	if (name.length === 0) {
		throw new InvalidCredentialError(`${where}: account name is empty.`);
	}
	if (name.length > MAX_ACCOUNT_NAME_LENGTH) {
		throw new InvalidCredentialError(
			`${where}: account name is too long (${name.length} > ${MAX_ACCOUNT_NAME_LENGTH}).`,
		);
	}
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i);
		if (code <= 0x20 || code >= 0x7f) {
			throw new InvalidCredentialError(
				`${where}: account name contains an unsupported character at position ${i}.`,
			);
		}
	}
}

/**
 * `WORK=xxx,TEAM=yyy` を解析する。
 * 値自体に `=` が含まれても壊れないよう、最初の `=` だけで分割する。
 */
export function parsePairList(raw: string, where: string, label: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of raw.split(",")) {
		const trimmed = entry.trim();
		if (trimmed.length === 0) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) {
			throw new InvalidCredentialError(
				`${where}: expected "account=${label}" entries separated by commas.`,
			);
		}
		const name = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		assertValidAccountName(name, where);
		assertValidValue(value, where, label);
		const normalized = name.toLowerCase();
		if (normalized in out) {
			throw new InvalidCredentialError(
				`${where}: account "${name}" is listed more than once.`,
			);
		}
		out[normalized] = value;
	}
	return out;
}

/** 単一指定と複数指定のヘッダを1つに正規化する */
function mergeSingleAndList(
	single: string | undefined,
	list: string | undefined,
	singleHeader: string,
	listHeader: string,
	label: string,
): Record<string, string> {
	const out = list ? parsePairList(list, listHeader, label) : {};
	if (single !== undefined) {
		const value = single.trim();
		assertValidValue(value, singleHeader, label);
		out[DEFAULT_ACCOUNT_SENTINEL] = value;
	}
	return out;
}

/** 4つのヘッダ値を UserCredentials に正規化する */
export function parseCredentialHeaders(headers: {
	apiKey?: string;
	apiKeys?: string;
	org?: string;
	orgs?: string;
}): UserCredentials {
	return {
		keys: mergeSingleAndList(
			headers.apiKey,
			headers.apiKeys,
			API_KEY_HEADER,
			API_KEYS_HEADER,
			"API key",
		),
		orgs: mergeSingleAndList(
			headers.org,
			headers.orgs,
			ORG_HEADER,
			ORGS_HEADER,
			"organizationKey",
		),
	};
}

/** 予約名をデフォルトアカウントへ解決しつつ、経路内の重複を検出する */
function resolveNames(
	source: Record<string, string>,
	defaultAccount: string,
	where: string,
): Record<string, string> {
	const resolved: Record<string, string> = {};
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(source)) {
		const target = name === DEFAULT_ACCOUNT_SENTINEL ? defaultAccount.toLowerCase() : name;
		if (!target) {
			throw new InvalidCredentialError(
				`${where}: this server has no default account, so name the account explicitly ` +
					`(for example "MINE=value").`,
			);
		}
		// 同じ経路の中で同じアカウントを二重に指した場合は、どちらが勝つかを
		// 暗黙に決めず明示的に失敗させる。
		if (seen.has(target)) {
			throw new InvalidCredentialError(
				`${where}: two different values were supplied for account "${target}" ` +
					`(the single-value header applies to the default account). Send only one.`,
			);
		}
		seen.add(target);
		resolved[target] = value;
	}
	return resolved;
}

/**
 * 設定済みアカウントに利用者本人のキーと組織を重ねた、新しい設定を返す。
 *
 * 元の config は書き換えない。リクエストごとに使い捨てる設定を作ることで、
 * ある利用者のキーが別のリクエストへ漏れないようにする。
 *
 * sources は優先度の低い順に並べる。運搬経路が複数ある場合 (トークンの封筒と
 * ヘッダ) に、後のものを優先させるため。
 */
export function applyUserCredentials(
	config: CacooAccountsConfig,
	...sources: UserCredentials[]
): CacooAccountsConfig {
	// まず既定アカウントを決める。設定側が空なら、最初に名指しされたものを使う。
	let defaultAccount = config.defaultAccount;
	if (!defaultAccount) {
		for (const source of sources) {
			const named = Object.keys(source.keys ?? {}).find((n) => n !== DEFAULT_ACCOUNT_SENTINEL);
			if (named) {
				defaultAccount = named;
				break;
			}
		}
	}

	const keys: UserApiKeys = {};
	const orgs: UserOrgKeys = {};
	for (const source of sources) {
		Object.assign(keys, resolveNames(source.keys ?? {}, defaultAccount, API_KEYS_HEADER));
		Object.assign(orgs, resolveNames(source.orgs ?? {}, defaultAccount, ORGS_HEADER));
	}

	const byName = new Map(config.accounts.map((a) => [a.name.toLowerCase(), a]));
	const mentioned = new Set([...Object.keys(keys), ...Object.keys(orgs)]);

	// 設定に無いアカウント名は、持ち込みが許可されているときだけ作る。
	// 許可されていなければ、綴り間違いを黙って共有キーへ落とさずエラーにする。
	const created: CacooAccount[] = [];
	for (const name of mentioned) {
		if (byName.has(name)) continue;
		if (!config.allowClientAccounts) {
			const available = config.accounts.map((a) => a.name).join(", ") || "(none)";
			throw new InvalidCredentialError(
				`No Cacoo account named "${name}" is configured. Available accounts: ${available}. ` +
					`Ask the administrator to configure it, or to enable allowClientAccounts.`,
			);
		}
		created.push({ name, readOnly: false, baseUrl: defaultBaseUrl(config) });
	}

	const accounts: CacooAccount[] = [...config.accounts, ...created].map((account) => {
		const lower = account.name.toLowerCase();
		const key = keys[lower];
		const org = orgs[lower];
		return {
			...account,
			apiKey: key ?? account.apiKey,
			keySource: key ? "user" : account.apiKey ? "server" : undefined,
			organizationKey: org ?? account.organizationKey,
			orgSource: org ? "user" : account.organizationKey ? "server" : undefined,
		};
	});

	return {
		...config,
		accounts,
		defaultAccount: config.defaultAccount || defaultAccount,
	};
}

/**
 * 持ち込みアカウントに使う baseUrl。
 * 宛先は必ずサーバ側が決める。クライアントが接続先を動かせると、サーバが
 * 任意ホストへの踏み台になるため、クライアントからは受け取らない。
 */
function defaultBaseUrl(config: CacooAccountsConfig): string {
	return config.accounts[0]?.baseUrl ?? DEFAULT_BASE_URL;
}

/**
 * サーバ側に共有キーが無く、本人のキーを受け取らないと使えないアカウント名。
 *
 * ヘッダを送れない GUI クライアント向けに、同意画面へ入力欄を出す対象を決める。
 * 全アカウントが共有キーを持つ構成では空になり、同意画面の見た目は変わらない。
 */
export function accountsNeedingUserKey(accountsConfig: string): string[] {
	return parseAccountsConfig(accountsConfig)
		.accounts.filter((a) => !a.apiKey)
		.map((a) => a.name);
}
