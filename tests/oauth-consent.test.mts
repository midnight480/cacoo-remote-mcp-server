// AWS 版の同意画面 (consent.ts) と authorize() の同意ゲートを検証する。
// セキュリティレビュー指摘への対応が実際に攻撃を止めるかを確認する。
//   npm run test:oauth-consent

import {
  approvalKey, approvedClientsCookie, isClientApproved,
  issueCsrfToken, validateCsrfToken, escapeHtml, sanitizeUrl,
} from "../src/oauth/consent.ts";
import { McpOAuthProvider } from "../src/oauth/provider.ts";

const SECRET = "test-cookie-secret-0123456789abcdef";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`  ${c ? "OK " : "NG "} ${n}${e}`); c ? pass++ : fail++; };

const reqWith = (cookie?: string, method = "GET", body: any = {}, query: any = {}) =>
  ({ headers: cookie ? { cookie } : {}, method, body, query, originalUrl: "/authorize?x=1" }) as any;

console.log("エスケープ:");
ok("HTML 特殊文字",  escapeHtml(`<img src=x onerror="a">&'`) === "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#039;");
ok("javascript: を拒否", sanitizeUrl("javascript:alert(1)") === "");
ok("data: を拒否",       sanitizeUrl("data:text/html,x") === "");
ok("制御文字を拒否",     sanitizeUrl("https://a" + String.fromCharCode(1) + ".example/") === "");
ok("https は通す",       sanitizeUrl("https://ok.example/cb") === "https://ok.example/cb");

console.log("承認 Cookie:");
const key = approvalKey("client-A", "https://ok.example/cb");
const cookie = approvedClientsCookie(reqWith(), key, SECRET);
const cookieVal = cookie.split(";")[0];
ok("__Host- 接頭辞",     cookie.startsWith("__Host-APPROVED_CLIENTS="));
ok("HttpOnly/Secure",    cookie.includes("HttpOnly") && cookie.includes("Secure") && cookie.includes("SameSite=Lax"));
ok("発行後は承認済み",   isClientApproved(reqWith(cookieVal), key, SECRET));
ok("別クライアントは未承認", !isClientApproved(reqWith(cookieVal), approvalKey("client-B", "https://ok.example/cb"), SECRET));
ok("redirect_uri を変えると未承認", !isClientApproved(reqWith(cookieVal), approvalKey("client-A", "https://evil.example/cb"), SECRET));
ok("別の鍵では検証失敗", !isClientApproved(reqWith(cookieVal), key, "another-secret"));

const sig = cookieVal.split("__Host-APPROVED_CLIENTS=")[1].split(".")[0];
const forgedPayload = Buffer.from(JSON.stringify([key, "client-EVIL|https://evil.example/cb"])).toString("base64");
const forged = `__Host-APPROVED_CLIENTS=${sig}.${forgedPayload}`;
ok("payload 改ざんを拒否", !isClientApproved(reqWith(forged), "client-EVIL|https://evil.example/cb", SECRET));

console.log("CSRF:");
const { token, setCookie } = issueCsrfToken();
const csrfCookie = setCookie.split(";")[0];
ok("一致で通る",       validateCsrfToken(reqWith(csrfCookie, "POST", { csrf_token: token })));
ok("不一致は拒否",     !validateCsrfToken(reqWith(csrfCookie, "POST", { csrf_token: "wrong" })));
ok("Cookie 無しは拒否", !validateCsrfToken(reqWith(undefined, "POST", { csrf_token: token })));
ok("フォーム値無しは拒否", !validateCsrfToken(reqWith(csrfCookie, "POST", {})));

console.log("authorize() の同意ゲート:");
const store: any = { putUpstreamState: async () => {}, getClient: async () => undefined };
const upstream: any = { buildAuthorizeUrl: () => "https://idp.example/oauth2/authorize?x=1" };
const prov = new McpOAuthProvider({
  store, upstream, allowedEmails: "[]", cookieSecret: SECRET, serverName: "Test Server",
});
const client: any = { client_id: "client-A", client_name: "Evil <script>Client</script>", redirect_uris: ["https://evil.example/cb"] };
const params: any = { redirectUri: "https://evil.example/cb", codeChallenge: "c", scopes: ["openid"], state: "s" };

const mkRes = (req: any) => {
  const r: any = { req, headers: {} as Record<string, any>, statusCode: 200, body: "", redirected: "" };
  r.setHeader = (k: string, v: any) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.type = () => r; r.send = (b: string) => { r.body = b; return r; };
  r.json = (b: any) => { r.body = JSON.stringify(b); return r; };
  r.redirect = (u: string) => { r.redirected = u; };
  return r;
};

let res = mkRes(reqWith(undefined, "GET"));
await prov.authorize(client, params, res);
ok("同意画面を返す (200)",   res.statusCode === 200 && res.body.includes("is requesting access"));
ok("上流へ飛ばない",         res.redirected === "");
ok("redirect_uri を表示",    res.body.includes("https://evil.example/cb"));
ok("クライアント名をエスケープ", res.body.includes("&lt;script&gt;") && !res.body.includes("<script>Client"));
ok("CSRF Cookie を発行",     String(res.headers["set-cookie"]).startsWith("__Host-CSRF_TOKEN="));
ok("クリックジャッキング対策", res.headers["x-frame-options"] === "DENY");

res = mkRes(reqWith(undefined, "POST", {}));
await prov.authorize(client, params, res);
ok("CSRF 無しの POST を拒否", res.statusCode === 400 && res.redirected === "");

const c2 = issueCsrfToken();
res = mkRes(reqWith(c2.setCookie.split(";")[0], "POST", { csrf_token: c2.token }));
await prov.authorize(client, params, res);
ok("承認後は上流へ",         res.redirected.startsWith("https://idp.example/"));
const setCookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
ok("承認 Cookie を発行",     setCookies.some((c) => c.startsWith("__Host-APPROVED_CLIENTS=")));
ok("CSRF Cookie を破棄",     setCookies.some((c) => c.startsWith("__Host-CSRF_TOKEN=;")));

const approved = approvedClientsCookie(reqWith(), approvalKey("client-A", "https://evil.example/cb"), SECRET).split(";")[0];
res = mkRes(reqWith(approved, "GET"));
await prov.authorize(client, params, res);
ok("承認済みは同意画面を出さない", res.redirected.startsWith("https://idp.example/") && res.body === "");

console.log("\n" + (fail ? "NG" : "OK") + ` pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
