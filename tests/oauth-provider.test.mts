// OAuth 認可サーバ (McpOAuthProvider) のロジック検証。
// AuthStore と上流 IdP はスタブに差し替え、フローと拒否パスだけを対象にする。
// プラットフォームに依存しないので、AWS 以外を足しても同じテストが使える。
//   npm run test:oauth
import { createHash, randomBytes } from "node:crypto";
const { McpOAuthProvider } = await import("../src/oauth/provider.ts");

// AuthStore のインメモリ実装 (永続化層を使わずロジックだけ検証)
class MemStore {
  m = new Map<string, any>();
  private now() { return Math.floor(Date.now()/1000); }
  private get(k: string) { const v = this.m.get(k); if (!v) return undefined;
    if (typeof v.expiresAt === "number" && v.expiresAt <= this.now()) return undefined; return v; }
  async getClient(id: string) { return this.get(`client#${id}`)?.client; }
  async putClient(c: any) { this.m.set(`client#${c.client_id}`, { client: c }); }
  async putUpstreamState(r: any) { this.m.set(`ustate#${r.state}`, r); }
  async takeUpstreamState(s: string) { const r = this.get(`ustate#${s}`); this.m.delete(`ustate#${s}`); return r; }
  async putAuthCode(r: any) { this.m.set(`code#${r.code}`, r); }
  async peekAuthCode(c: string) { return this.get(`code#${c}`); }
  async takeAuthCode(c: string) { const r = this.peekAuthCode(c); this.m.delete(`code#${c}`); return r; }
  async putToken(r: any) { this.m.set(`token#${r.token}`, r); }
  async getToken(t: string) { return this.get(`token#${t}`); }
  async deleteToken(t: string) { this.m.delete(`token#${t}`); }
}

const store = new MemStore();
const identity = { email: "ok@example.com", sub: "sub-1", name: "OK" };
// 上流 IdP をスタブ化して provider 本体のロジックだけを検証する
const upstream = {
  buildAuthorizeUrl: (state: string, challenge: string) => {
    const u = new URL("https://u.example.com/oauth2/authorize");
    u.search = new URLSearchParams({ state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    return u.toString(); },
  exchangeCode: async () => ({ access_token: "a", id_token: "i" }),
  verifyIdToken: async () => identity,
};

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`  ${c ? "OK " : "NG "} ${n}${e}`); c ? pass++ : fail++; };
const throws = async (n: string, fn: () => Promise<any>, want: RegExp) => {
  try { await fn(); ok(n, false, "  (例外が出なかった)"); }
  catch (e: any) { ok(n, want.test(e.message), want.test(e.message) ? "" : `  msg=${e.message}`); } };

const COOKIE_SECRET = "test-cookie-secret";
const prov = new McpOAuthProvider({ store: store as any, upstream,
  allowedEmails: '["ok@example.com"]', cookieSecret: COOKIE_SECRET, serverName: "Test" });

// authorize() は同意画面を挟むようになったため、承認済み Cookie を持つ
// リクエストを模して上流リダイレクトまで進める。同意フロー自体の検証は
// tests/aws-consent.test.mts が行う。
const { approvalKey, approvedClientsCookie } = await import("../src/oauth/consent.ts");
const approvedRes = (clientId: string, redirectUri: string) => {
  const cookie = approvedClientsCookie({ headers: {} } as any, approvalKey(clientId, redirectUri), COOKIE_SECRET).split(";")[0];
  let captured = "";
  return {
    req: { headers: { cookie }, method: "GET", query: {}, body: {}, originalUrl: "/authorize" },
    setHeader: () => {}, status: () => ({ json: () => {} }),
    redirect: (u: string) => { captured = u; },
    get url() { return captured; },
  } as any;
};

// --- クライアント登録 (DCR) ---
const client = await (prov.clientsStore as any).registerClient({
  redirect_uris: ["https://client.example.com/cb"], grant_types: ["authorization_code","refresh_token"],
  response_types: ["code"], token_endpoint_auth_method: "none" });
ok("DCR: client_id が発行される", !!client.client_id && client.client_id.length >= 16);
ok("DCR: 保存され取得できる", (await prov.clientsStore.getClient(client.client_id))?.client_id === client.client_id);

// --- authorize: 上流へのリダイレクト ---
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
let redirectedTo = "";
const aRes = approvedRes(client.client_id, "https://client.example.com/cb");
await prov.authorize(client, { redirectUri: "https://client.example.com/cb", codeChallenge: challenge,
  scopes: ["openid"], state: "mcp-state" } as any, aRes);
redirectedTo = aRes.url;
const uurl = new URL(redirectedTo);
ok("authorize: 上流の /oauth2/authorize へ", uurl.pathname === "/oauth2/authorize");
ok("authorize: PKCE S256 を送る", uurl.searchParams.get("code_challenge_method") === "S256");
const upstreamState = uurl.searchParams.get("state")!;
ok("authorize: state が生成される", !!upstreamState && upstreamState.length >= 32);

// --- callback: 認可コード発行 ---
const back = await prov.handleUpstreamCallback("upstream-code", upstreamState);
const burl = new URL(back);
ok("callback: クライアントへ戻る", burl.origin + burl.pathname === "https://client.example.com/cb");
ok("callback: mcp の state を保つ", burl.searchParams.get("state") === "mcp-state");
const authCode = burl.searchParams.get("code")!;
ok("callback: 認可コードが付く", !!authCode);

await throws("callback: state 再利用は拒否", () => prov.handleUpstreamCallback("c", upstreamState), /Unknown or expired state/);

// --- PKCE ---
ok("challengeForAuthorizationCode が一致", await prov.challengeForAuthorizationCode(client, authCode) === challenge);
await throws("PKCE 不一致は拒否", () => prov.exchangeAuthorizationCode(client, authCode, "wrong-verifier", "https://client.example.com/cb"), /code_verifier/);

// PKCE 失敗で認可コードが消費されてしまっていないか
const stillThere = await store.peekAuthCode(authCode);
ok("PKCE 失敗後もコードは残らない(使い捨て)", stillThere === undefined);

// --- 正常なトークン交換 ---
const mkState = async (p: any, cl: any = client, uri = "https://client.example.com/cb") => {
  const r = approvedRes(cl.client_id, uri);
  await p.authorize(cl, { redirectUri: uri, codeChallenge: challenge, scopes: ["openid"], state: "s" } as any, r);
  return new URL(r.url).searchParams.get("state")!;
};
const st2 = await mkState(prov);
const code2 = new URL(await prov.handleUpstreamCallback("c", st2)).searchParams.get("code")!;
const tokens = await prov.exchangeAuthorizationCode(client, code2, verifier, "https://client.example.com/cb");
ok("トークン発行", !!tokens.access_token && !!tokens.refresh_token && tokens.token_type === "bearer");

const info = await prov.verifyAccessToken(tokens.access_token);
ok("verifyAccessToken でメールが取れる", (info.extra as any)?.userEmail === "ok@example.com");
ok("clientId が一致", info.clientId === client.client_id);

await throws("認可コード再利用は拒否", () => prov.exchangeAuthorizationCode(client, code2, verifier, "https://client.example.com/cb"), /Invalid authorization code/);

// --- redirect_uri 不一致 ---
const st3 = await mkState(prov);
const code3 = new URL(await prov.handleUpstreamCallback("c", st3)).searchParams.get("code")!;
await throws("redirect_uri 不一致は拒否", () => prov.exchangeAuthorizationCode(client, code3, verifier, "https://evil.example.com/cb"), /redirect_uri/);

// --- リフレッシュ ---
const refreshed = await prov.exchangeRefreshToken(client, tokens.refresh_token!, ["openid"]);
ok("リフレッシュでトークン再発行", !!refreshed.access_token && refreshed.access_token !== tokens.access_token);
await throws("旧リフレッシュトークンは無効(ローテーション)", () => prov.exchangeRefreshToken(client, tokens.refresh_token!), /Invalid refresh token/);
await throws("スコープ拡大は拒否", () => prov.exchangeRefreshToken(client, refreshed.refresh_token!, ["openid","admin"]), /Cannot widen scope/);

// --- 他クライアントのトークンを失効させられないか ---
const other = await (prov.clientsStore as any).registerClient({ redirect_uris: ["https://o.example.com/cb"],
  grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" });
await prov.revokeToken(other, { token: refreshed.access_token } as any);
ok("他クライアントは失効させられない", !!(await store.getToken(refreshed.access_token)));
await prov.revokeToken(client, { token: refreshed.access_token } as any);
ok("自分のトークンは失効できる", !(await store.getToken(refreshed.access_token)));

// --- 許可リスト外のユーザー ---
const prov2 = new McpOAuthProvider({ store: store as any, upstream,
  allowedEmails: '["someone-else@example.com"]', cookieSecret: COOKIE_SECRET, serverName: "Test" });
const st4 = await mkState(prov2);
const denied = new URL(await prov2.handleUpstreamCallback("c", st4));
ok("許可外は access_denied で戻す", denied.searchParams.get("error") === "access_denied");
ok("許可外はコードを発行しない", !denied.searchParams.get("code"));

console.log(`\n${fail ? "✘" : "✅"} pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
