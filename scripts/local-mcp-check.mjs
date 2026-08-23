#!/usr/bin/env node
// ローカル起動した Worker に対して OAuth を通し、MCP の疎通確認まで行うスクリプト。
//   node scripts/local-mcp-check.mjs [--base http://localhost:8788]
// ブラウザで Cloudflare Access のログインを完了させると、認可コードを受け取って
// トークン交換 → initialize → tools/list → get_account の呼び出しまで実行する。

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const BASE = valueOf("--base") ?? "http://localhost:8788";
const CB_PORT = Number(valueOf("--callback-port") ?? 9876);
const CB_URL = `http://127.0.0.1:${CB_PORT}/callback`;

function valueOf(flag) {
	const i = args.indexOf(flag);
	return i === -1 ? undefined : args[i + 1];
}

const b64url = (buf) => buf.toString("base64url");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

function log(step, msg) {
	console.log(`\n\x1b[36m[${step}]\x1b[0m ${msg}`);
}

async function main() {
	log("1/6", `AS メタデータ取得: ${BASE}/.well-known/oauth-authorization-server`);
	const metaRes = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
	if (!metaRes.ok) throw new Error(`メタデータ取得失敗: HTTP ${metaRes.status}`);
	const meta = await metaRes.json();
	console.log(`    issuer = ${meta.issuer}`);

	log("2/6", "動的クライアント登録");
	const regRes = await fetch(meta.registration_endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "local-mcp-check",
			redirect_uris: [CB_URL],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	if (!regRes.ok) throw new Error(`登録失敗: HTTP ${regRes.status} ${await regRes.text()}`);
	const client = await regRes.json();
	console.log(`    client_id = ${client.client_id}`);

	const authorizeUrl = new URL(meta.authorization_endpoint);
	authorizeUrl.search = new URLSearchParams({
		response_type: "code",
		client_id: client.client_id,
		redirect_uri: CB_URL,
		scope: "openid",
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
	}).toString();

	log("3/6", "ブラウザで承認 → Cloudflare Access ログインを完了してください");
	console.log(`    ${authorizeUrl}`);

	const codePromise = waitForCode();
	spawn("open", [authorizeUrl.toString()], { stdio: "ignore", detached: true }).unref();
	const code = await codePromise;
	console.log(`    認可コードを受信しました`);

	log("4/6", "トークン交換");
	const tokenRes = await fetch(meta.token_endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: CB_URL,
			client_id: client.client_id,
			code_verifier: verifier,
		}),
	});
	const token = await tokenRes.json();
	if (!tokenRes.ok) throw new Error(`トークン交換失敗: HTTP ${tokenRes.status} ${JSON.stringify(token)}`);
	console.log(`    access_token を取得 (${token.token_type}, expires_in=${token.expires_in})`);

	const mcp = mcpCaller(`${BASE}/mcp`, token.access_token);

	log("5/6", "MCP initialize + tools/list");
	const init = await mcp("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "local-mcp-check", version: "1.0.0" },
	});
	console.log(`    server = ${init.serverInfo?.name} v${init.serverInfo?.version}`);
	await mcp("notifications/initialized", undefined, true);

	const list = await mcp("tools/list", {});
	console.log(`    tools (${list.tools.length}):`);
	for (const t of list.tools) console.log(`      - ${t.name}`);

	if (list.tools.some((t) => t.name === "access_denied")) {
		console.log("\n\x1b[33m    ALLOWED_EMAILS に該当しないため access_denied のみ登録されています\x1b[0m");
	}

	log("6/6", "Cacoo API 疎通 (get_account)");
	const accountTool = list.tools.find((t) => t.name === "get_account") ?? list.tools[0];
	const result = await mcp("tools/call", { name: accountTool.name, arguments: {} });
	const text = result.content?.map((c) => c.text).join("\n") ?? JSON.stringify(result);
	console.log(`    ${accountTool.name} →`);
	console.log(text.split("\n").map((l) => `      ${l}`).join("\n").slice(0, 2000));
	console.log(result.isError ? "\n\x1b[31m    ツールがエラーを返しました\x1b[0m" : "\n\x1b[32m✅ 疎通確認 OK\x1b[0m");
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const page = (title, body) =>
	`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
	`<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`;

function waitForCode() {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (fn, arg) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			server.close();
			fn(arg);
		};

		const server = createServer((req, res) => {
			const url = new URL(req.url, `http://127.0.0.1:${CB_PORT}`);
			if (url.pathname !== "/callback") {
				res.writeHead(404).end();
				return;
			}

			// state を先に検証する。一致しないリクエスト (ブラウザのプリフェッチや
			// 無関係なアクセス) でリスナーを閉じてしまわないよう、ここでは返答だけ
			// してフローは継続させる。
			if (url.searchParams.get("state") !== state) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(page("不正なリクエスト", "state が一致しません。"));
				return;
			}

			const err = url.searchParams.get("error");
			const code = url.searchParams.get("code");

			if (err) {
				const detail = `${err} ${url.searchParams.get("error_description") ?? ""}`.trim();
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(page("認可に失敗しました", "詳細はターミナルを確認してください。"));
				finish(reject, new Error(`認可エラー: ${detail}`));
				return;
			}
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(page("不正なリクエスト", "code がありません。"));
				finish(reject, new Error("認可コードが返されませんでした"));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(page("認可されました", "ターミナルに戻ってください。"));
			finish(resolve, code);
		});

		server.listen(CB_PORT, "127.0.0.1");
		const timer = setTimeout(
			() => finish(reject, new Error("認可待ちがタイムアウトしました (5分)")),
			300_000,
		);
	});
}

function mcpCaller(endpoint, accessToken) {
	let sessionId;
	let id = 0;
	return async (method, params, isNotification = false) => {
		const headers = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${accessToken}`,
		};
		if (sessionId) headers["mcp-session-id"] = sessionId;
		const body = { jsonrpc: "2.0", method, ...(params !== undefined && { params }) };
		if (!isNotification) body.id = ++id;

		const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
		const sid = res.headers.get("mcp-session-id");
		if (sid) sessionId = sid;
		if (isNotification) return undefined;
		if (!res.ok) throw new Error(`${method} 失敗: HTTP ${res.status} ${await res.text()}`);

		const raw = await res.text();
		const json = raw.startsWith("event:") || raw.startsWith("data:")
			? JSON.parse(raw.split("\n").find((l) => l.startsWith("data:")).slice(5).trim())
			: JSON.parse(raw);
		if (json.error) throw new Error(`${method} エラー: ${JSON.stringify(json.error)}`);
		return json.result;
	};
}

main().catch((e) => { console.error(`\n\x1b[31m✘ ${e.message}\x1b[0m`); process.exit(1); });
