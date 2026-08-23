// oauth/consent.ts
// 認可の同意画面。Cloudflare 版の workers-oauth-utils.ts が担っている役割を、
// Node 系の実行環境向けに実装したもの。
//
// なぜ必要か:
//   /register (RFC 7591 動的クライアント登録) は認証なしで誰でも叩けるため、
//   攻撃者が自分の redirect_uri を持つクライアントを登録できる。SDK は
//   redirect_uri を「そのクライアント自身が登録した URI」としか照合しないので、
//   登録が唯一の関門になる。同意画面が無いと、攻撃者が用意した認可 URL を
//   許可済みユーザーに踏ませるだけで認可コードが攻撃者へ渡る。攻撃者自身が
//   フローを開始するため PKCE は防御にならない (code_challenge も攻撃者のもの)。
//
// 同意画面はリソース所有者の意思を特定の client_id + redirect_uri に結び付ける
// 唯一の制御であり、省略できない。

import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

const CSRF_COOKIE = "__Host-CSRF_TOKEN";
const APPROVED_COOKIE = "__Host-APPROVED_CLIENTS";
const CSRF_MAX_AGE_SEC = 600;
const APPROVAL_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/** http/https 以外のスキームと制御文字を弾く。javascript: などを表示させない。 */
export function sanitizeUrl(url: string): string {
	const normalized = url.trim();
	if (!normalized) return "";
	for (let i = 0; i < normalized.length; i++) {
		const code = normalized.charCodeAt(i);
		if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) return "";
	}
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		return "";
	}
	const scheme = parsed.protocol.slice(0, -1).toLowerCase();
	return scheme === "http" || scheme === "https" ? normalized : "";
}

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

function sign(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
	}
	return out;
}

// --- 承認済みクライアント (署名付き Cookie) ---

function readApprovedClients(req: Request, secret: string): string[] {
	const raw = parseCookies(req.headers.cookie)[APPROVED_COOKIE];
	if (!raw) return [];
	const dot = raw.indexOf(".");
	if (dot === -1) return [];
	const signature = raw.slice(0, dot);
	const encoded = raw.slice(dot + 1);
	let payload: string;
	try {
		payload = Buffer.from(encoded, "base64").toString("utf8");
	} catch {
		return [];
	}
	// 署名が合わないものは無視する (改ざんされた Cookie で承認を偽装させない)
	if (!safeEqual(signature, sign(payload, secret))) return [];
	try {
		const list = JSON.parse(payload);
		return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

/**
 * このクライアントが以前に承認済みか。
 * client_id だけでなく redirect_uri も含めた鍵で判定するため、同じ client_id で
 * redirect_uri を差し替えて再登録しても過去の承認を引き継げない。
 */
export function approvalKey(clientId: string, redirectUri: string): string {
	return `${clientId}|${redirectUri}`;
}

export function isClientApproved(req: Request, key: string, secret: string): boolean {
	return readApprovedClients(req, secret).includes(key);
}

export function approvedClientsCookie(req: Request, key: string, secret: string): string {
	const updated = Array.from(new Set([...readApprovedClients(req, secret), key]));
	const payload = JSON.stringify(updated);
	const value = `${sign(payload, secret)}.${Buffer.from(payload).toString("base64")}`;
	return `${APPROVED_COOKIE}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${APPROVAL_MAX_AGE_SEC}`;
}

// --- CSRF ---

export function issueCsrfToken(): { token: string; setCookie: string } {
	const token = randomUUID();
	return {
		token,
		setCookie: `${CSRF_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${CSRF_MAX_AGE_SEC}`,
	};
}

export function validateCsrfToken(req: Request): boolean {
	const fromForm = (req.body as Record<string, unknown> | undefined)?.csrf_token;
	if (typeof fromForm !== "string" || !fromForm) return false;
	const fromCookie = parseCookies(req.headers.cookie)[CSRF_COOKIE];
	if (!fromCookie) return false;
	return safeEqual(fromForm, fromCookie);
}

export const clearCsrfCookie = `${CSRF_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;

// --- 同意画面 ---

export interface ApprovalDialogOptions {
	serverName: string;
	clientName?: string;
	redirectUri: string;
	/** 元の認可リクエストのパラメータ。そのまま hidden で POST し直す */
	params: Record<string, string>;
	csrfToken: string;
	actionPath: string;
}

export function renderApprovalDialog(res: Response, opts: ApprovalDialogOptions): void {
	const serverName = escapeHtml(opts.serverName);
	const clientName = escapeHtml(opts.clientName || "Unknown MCP Client");
	const redirectUri = escapeHtml(sanitizeUrl(opts.redirectUri) || "(invalid redirect URI)");

	const hidden = Object.entries(opts.params)
		.map(
			([k, v]) =>
				`<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`,
		)
		.join("\n");

	res.status(200).type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${clientName} | Authorization Request</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f9fafb; margin: 0; padding: 2rem; }
.card { max-width: 520px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); padding: 2rem; }
h1 { font-size: 1.3rem; text-align: center; }
h2 { font-size: 1.1rem; font-weight: 400; text-align: center; }
dl { background: #f3f4f6; border-radius: 8px; padding: 1rem; font-size: .9rem; }
dt { color: #6b7280; }
dd { margin: 0 0 .75rem; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
dd:last-child { margin-bottom: 0; }
.actions { display: flex; justify-content: flex-end; gap: 1rem; margin-top: 2rem; }
.btn { padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: 500; cursor: pointer; border: none; font-size: 1rem; }
.btn-primary { background: #0070f3; color: #fff; }
.btn-secondary { background: transparent; border: 1px solid #e5e7eb; }
</style>
</head>
<body>
<div class="card">
<h1>${serverName}</h1>
<h2><strong>${clientName}</strong> is requesting access</h2>
<p>If you approve, you will be redirected to sign in, and this client will receive access on your behalf. Check the redirect target below before approving.</p>
<dl>
<dt>Client</dt><dd>${clientName}</dd>
<dt>Redirect to</dt><dd>${redirectUri}</dd>
</dl>
<form method="post" action="${escapeHtml(opts.actionPath)}">
${hidden}
<input type="hidden" name="csrf_token" value="${escapeHtml(opts.csrfToken)}">
<div class="actions">
<button type="button" class="btn btn-secondary" onclick="window.history.back()">Cancel</button>
<button type="submit" class="btn btn-primary">Approve</button>
</div>
</form>
</div>
</body>
</html>`);
}
