// 上流 OIDC のエンドポイント解決を検証する。
// IdP ごとに authorize / token / JWKS の位置が違うため、既定の Cognito 形式が
// 壊れていないことと、Google / Entra ID を明示指定で扱えることを確認する。
//   npm run test:oauth-upstream

import {
  authorizationEndpointOf, tokenEndpointOf, jwksUriOf, buildAuthorizeUrl,
} from "../src/oauth/upstream.ts";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`  ${c ? "OK " : "NG "} ${n}${e}`); c ? pass++ : fail++; };

const base = { clientId: "cid", redirectUri: "https://mcp.example.com/callback" };

console.log("Cognito (domain から既定で組み立てる):");
const cognito = {
  ...base,
  domain: "https://backlog-mcp-x.auth.ap-northeast-1.amazoncognito.com",
  issuer: "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_ABC",
};
ok("authorize", authorizationEndpointOf(cognito)
  === "https://backlog-mcp-x.auth.ap-northeast-1.amazoncognito.com/oauth2/authorize");
ok("token", tokenEndpointOf(cognito)
  === "https://backlog-mcp-x.auth.ap-northeast-1.amazoncognito.com/oauth2/token");
ok("jwks", jwksUriOf(cognito)
  === "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_ABC/.well-known/jwks.json");

console.log("Google (別ホストに散っている):");
const google = {
  ...base,
  issuer: "https://accounts.google.com",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
};
ok("authorize", authorizationEndpointOf(google) === "https://accounts.google.com/o/oauth2/v2/auth");
ok("token", tokenEndpointOf(google) === "https://oauth2.googleapis.com/token");
ok("jwks", jwksUriOf(google) === "https://www.googleapis.com/oauth2/v3/certs");
ok("domain 無しでも解決できる", !("domain" in google));

console.log("Entra ID (issuer から JWKS を導けない):");
const tenant = "11111111-2222-3333-4444-555555555555";
const entra = {
  ...base,
  issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
  authorizationEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
  tokenEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
  jwksUri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
};
ok("jwks が issuer 直下ではない",
  jwksUriOf(entra) === `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`
  && jwksUriOf(entra) !== `${entra.issuer}/.well-known/jwks.json`);

console.log("issuer 末尾のスラッシュ:");
ok("重複しない",
  jwksUriOf({ ...base, issuer: "https://idp.example.com/" })
  === "https://idp.example.com/.well-known/jwks.json");

console.log("設定不足:");
let threw = false;
try { authorizationEndpointOf({ ...base, issuer: "https://i.example.com" }); } catch { threw = true; }
ok("domain もエンドポイントも無ければエラー", threw);

console.log("認可 URL の組み立て:");
const url = new URL(buildAuthorizeUrl(google, "st4te", "ch4llenge"));
ok("エンドポイントを使う", url.origin + url.pathname === "https://accounts.google.com/o/oauth2/v2/auth");
ok("PKCE は S256", url.searchParams.get("code_challenge_method") === "S256");
ok("challenge を載せる", url.searchParams.get("code_challenge") === "ch4llenge");
ok("state を載せる", url.searchParams.get("state") === "st4te");
ok("既定スコープ", url.searchParams.get("scope") === "openid email profile");
ok("redirect_uri", url.searchParams.get("redirect_uri") === base.redirectUri);

console.log(`\n${fail === 0 ? "OK" : "NG"} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
