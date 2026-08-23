// workers-oauth-utils.ts
// OAuth utility functions with CSRF and state validation security

import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";

export class OAuthError extends Error {
	constructor(
		public code: string,
		public description: string,
		public statusCode = 400,
	) {
		super(description);
		this.name = "OAuthError";
	}

	toResponse(): Response {
		return new Response(
			JSON.stringify({
				error: this.code,
				error_description: this.description,
			}),
			{
				status: this.statusCode,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export interface OAuthStateResult {
	stateToken: string;
	codeChallenge: string;
}

export interface ValidateStateResult {
	oauthReqInfo: AuthRequest;
	codeVerifier: string;
}

export interface CSRFProtectionResult {
	token: string;
	setCookie: string;
}

export interface ValidateCSRFResult {
	clearCookie: string;
}

export interface Props {
	accessToken: string;
	email: string;
	login: string;
	name: string;
	[key: string]: unknown;
}

export function sanitizeText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

export function sanitizeUrl(url: string): string {
	const normalized = url.trim();
	if (normalized.length === 0) return "";

	for (let i = 0; i < normalized.length; i++) {
		const code = normalized.charCodeAt(i);
		if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
			return "";
		}
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(normalized);
	} catch {
		return "";
	}

	const allowedSchemes = ["https", "http"];
	const scheme = parsedUrl.protocol.slice(0, -1).toLowerCase();
	if (!allowedSchemes.includes(scheme)) return "";

	return normalized;
}

export function generateCSRFProtection(): CSRFProtectionResult {
	const csrfCookieName = "__Host-CSRF_TOKEN";
	const token = crypto.randomUUID();
	const setCookie = `${csrfCookieName}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
	return { token, setCookie };
}

export function validateCSRFToken(formData: FormData, request: Request): ValidateCSRFResult {
	const csrfCookieName = "__Host-CSRF_TOKEN";
	const tokenFromForm = formData.get("csrf_token");

	if (!tokenFromForm || typeof tokenFromForm !== "string") {
		throw new OAuthError("invalid_request", "Missing CSRF token in form data", 400);
	}

	const cookieHeader = request.headers.get("Cookie") || "";
	const cookies = cookieHeader.split(";").map((c) => c.trim());
	const csrfCookie = cookies.find((c) => c.startsWith(`${csrfCookieName}=`));
	const tokenFromCookie = csrfCookie ? csrfCookie.substring(csrfCookieName.length + 1) : null;

	if (!tokenFromCookie) {
		throw new OAuthError("invalid_request", "Missing CSRF token cookie", 400);
	}

	if (tokenFromForm !== tokenFromCookie) {
		throw new OAuthError("invalid_request", "CSRF token mismatch", 400);
	}

	const clearCookie = `${csrfCookieName}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
	return { clearCookie };
}

export async function createOAuthState(
	oauthReqInfo: AuthRequest,
	kv: KVNamespace,
	secret: string,
	stateTTL = 600,
): Promise<OAuthStateResult> {
	const uuid = crypto.randomUUID();
	const { codeVerifier, codeChallenge } = await generatePKCE();

	const hmac = await signData(uuid, secret);
	const stateToken = `${uuid}.${hmac}`;

	await kv.put(`oauth:state:${uuid}`, JSON.stringify({ oauthReqInfo, codeVerifier }), {
		expirationTtl: stateTTL,
	});

	return { stateToken, codeChallenge };
}

export async function validateOAuthState(
	request: Request,
	kv: KVNamespace,
	secret: string,
): Promise<ValidateStateResult> {
	const url = new URL(request.url);
	const stateFromQuery = url.searchParams.get("state");

	if (!stateFromQuery) {
		throw new OAuthError("invalid_request", "Missing state parameter", 400);
	}

	const dotIndex = stateFromQuery.lastIndexOf(".");
	if (dotIndex === -1) {
		throw new OAuthError("invalid_request", "Invalid state format", 400);
	}
	const uuid = stateFromQuery.substring(0, dotIndex);
	const hmac = stateFromQuery.substring(dotIndex + 1);

	const isValid = await verifySignature(hmac, uuid, secret);
	if (!isValid) {
		throw new OAuthError("invalid_request", "Invalid state signature", 400);
	}

	const storedDataJson = await kv.get(`oauth:state:${uuid}`);
	if (!storedDataJson) {
		throw new OAuthError("invalid_request", "Invalid or expired state", 400);
	}

	let stored: { oauthReqInfo: AuthRequest; codeVerifier: string };
	try {
		stored = JSON.parse(storedDataJson) as { oauthReqInfo: AuthRequest; codeVerifier: string };
	} catch {
		throw new OAuthError("server_error", "Invalid state data", 500);
	}

	await kv.delete(`oauth:state:${uuid}`);
	return { oauthReqInfo: stored.oauthReqInfo, codeVerifier: stored.codeVerifier };
}

export async function isClientApproved(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<boolean> {
	const approvedClients = await getApprovedClientsFromCookie(request, cookieSecret);
	return approvedClients?.includes(clientId) ?? false;
}

export async function addApprovedClient(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<string> {
	const approvedClientsCookieName = "__Host-APPROVED_CLIENTS";
	const THIRTY_DAYS_IN_SECONDS = 2592000;

	const existingApprovedClients =
		(await getApprovedClientsFromCookie(request, cookieSecret)) || [];
	const updatedApprovedClients = Array.from(new Set([...existingApprovedClients, clientId]));

	const payload = JSON.stringify(updatedApprovedClients);
	const signature = await signData(payload, cookieSecret);
	const cookieValue = `${signature}.${btoa(payload)}`;

	return `${approvedClientsCookieName}=${cookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${THIRTY_DAYS_IN_SECONDS}`;
}

export interface ApprovalDialogOptions {
	client: ClientInfo | null;
	server: { name: string; logo?: string; description?: string };
	state: Record<string, any>;
	csrfToken: string;
	setCookie: string;
}

export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
	const { client, server, state, csrfToken, setCookie } = options;
	const encodedState = btoa(JSON.stringify(state));
	const serverName = sanitizeText(server.name);
	const clientName = client?.clientName ? sanitizeText(client.clientName) : "Unknown MCP Client";

	const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${clientName} | Authorization Request</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f9fafb; margin: 0; padding: 2rem; }
.card { max-width: 500px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); padding: 2rem; }
h1 { font-size: 1.3rem; text-align: center; }
h2 { font-size: 1.1rem; font-weight: 400; text-align: center; }
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
<p>This MCP Client is requesting authorization. If you approve, you will be redirected to complete authentication.</p>
<form method="post" action="${new URL(request.url).pathname}">
<input type="hidden" name="state" value="${encodedState}">
<input type="hidden" name="csrf_token" value="${csrfToken}">
<div class="actions">
<button type="button" class="btn btn-secondary" onclick="window.history.back()">Cancel</button>
<button type="submit" class="btn btn-primary">Approve</button>
</div>
</form>
</div>
</body>
</html>`;

	return new Response(htmlContent, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Set-Cookie": setCookie,
			"X-Frame-Options": "DENY",
			"Content-Security-Policy": "frame-ancestors 'none'",
		},
	});
}

export function getUpstreamAuthorizeUrl(params: {
	upstream_url: string;
	client_id: string;
	redirect_uri: string;
	scope: string;
	state: string;
	code_challenge: string;
	code_challenge_method?: string;
}): string {
	const url = new URL(params.upstream_url);
	url.searchParams.set("client_id", params.client_id);
	url.searchParams.set("redirect_uri", params.redirect_uri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", params.scope);
	url.searchParams.set("state", params.state);
	url.searchParams.set("code_challenge", params.code_challenge);
	url.searchParams.set("code_challenge_method", params.code_challenge_method ?? "S256");
	return url.toString();
}

export async function fetchUpstreamAuthToken(params: {
	upstream_url: string;
	client_id: string;
	client_secret: string;
	code?: string;
	redirect_uri: string;
	code_verifier: string;
}): Promise<[string, string, null] | [null, null, Response]> {
	if (!params.code) {
		return [null, null, new Response("Missing authorization code", { status: 400 })];
	}

	const data = new URLSearchParams({
		client_id: params.client_id,
		client_secret: params.client_secret,
		code: params.code,
		grant_type: "authorization_code",
		redirect_uri: params.redirect_uri,
		code_verifier: params.code_verifier,
	});

	const response = await fetch(params.upstream_url, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: data.toString(),
	});

	if (!response.ok) {
		const errorText = await response.text();
		return [
			null,
			null,
			new Response(`Failed to exchange code for token: ${errorText}`, { status: response.status }),
		];
	}

	const body = (await response.json()) as any;
	const accessToken = body.access_token as string;
	if (!accessToken) {
		return [null, null, new Response("Missing access token", { status: 400 })];
	}

	const idToken = body.id_token as string;
	if (!idToken) {
		return [null, null, new Response("Missing id token", { status: 400 })];
	}
	return [accessToken, idToken, null];
}

// --- Helper Functions ---

async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
	const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
	const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

	const encoder = new TextEncoder();
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
	const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

	return { codeVerifier, codeChallenge };
}

async function getApprovedClientsFromCookie(
	request: Request,
	cookieSecret: string,
): Promise<string[] | null> {
	const approvedClientsCookieName = "__Host-APPROVED_CLIENTS";
	const cookieHeader = request.headers.get("Cookie");
	if (!cookieHeader) return null;

	const cookies = cookieHeader.split(";").map((c) => c.trim());
	const targetCookie = cookies.find((c) => c.startsWith(`${approvedClientsCookieName}=`));
	if (!targetCookie) return null;

	const cookieValue = targetCookie.substring(approvedClientsCookieName.length + 1);
	const parts = cookieValue.split(".");
	if (parts.length !== 2) return null;

	const [signatureHex, base64Payload] = parts;
	const payload = atob(base64Payload);
	const isValid = await verifySignature(signatureHex, payload, cookieSecret);
	if (!isValid) return null;

	try {
		const approvedClients = JSON.parse(payload);
		if (!Array.isArray(approvedClients) || !approvedClients.every((item) => typeof item === "string")) {
			return null;
		}
		return approvedClients as string[];
	} catch {
		return null;
	}
}

async function signData(data: string, secret: string): Promise<string> {
	const key = await importKey(secret);
	const enc = new TextEncoder();
	const signatureBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(data));
	return Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function verifySignature(signatureHex: string, data: string, secret: string): Promise<boolean> {
	if (!signatureHex || !/^[0-9a-f]+$/i.test(signatureHex)) return false;
	const key = await importKey(secret);
	const enc = new TextEncoder();
	try {
		const signatureBytes = new Uint8Array(
			signatureHex.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)),
		);
		return await crypto.subtle.verify("HMAC", key, signatureBytes.buffer, enc.encode(data));
	} catch {
		return false;
	}
}

async function importKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new Error("cookieSecret is required for signing cookies");
	const enc = new TextEncoder();
	return crypto.subtle.importKey("raw", enc.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, [
		"sign",
		"verify",
	]);
}
