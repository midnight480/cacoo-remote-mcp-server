// Cacoo API クライアントの検証。
// アカウント振り分け・readOnly ガード・organizationKey の解決・URL 組み立て・
// エラー整形を対象にする。ネットワークは fetch を差し替えて遮断する。
//   npm run test:cacoo-client

import {
  parseAccountsConfig, resolveAccount, callCacooApi, callCacooApiBinary,
  formatCacooError, CacooApiError, ReadOnlyAccountError,
} from "../src/core/cacoo-client.ts";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`  ${c ? "OK " : "NG "} ${n}${e}`); c ? pass++ : fail++; };

const CONFIG = JSON.stringify({
  accounts: [
    { name: "main", apiKey: "KEY-MAIN", organizationKey: "org-main" },
    { name: "shared", apiKey: "KEY-SHARED", readOnly: true },
    { name: "onprem", apiKey: "KEY-OP", baseUrl: "https://cacoo.example.com/" },
  ],
  defaultAccount: "main",
});

console.log("設定の解析:");
const cfg = parseAccountsConfig(CONFIG);
ok("アカウント数", cfg.accounts.length === 3);
ok("既定アカウント", cfg.defaultAccount === "main");
ok("readOnly 未指定は false", cfg.accounts[0].readOnly === false);
ok("readOnly true はそのまま", cfg.accounts[1].readOnly === true);
ok("baseUrl 既定", cfg.accounts[0].baseUrl === "https://cacoo.com");
ok("baseUrl 末尾スラッシュを落とす", cfg.accounts[2].baseUrl === "https://cacoo.example.com");

let threw = false;
try { parseAccountsConfig("{ not json"); } catch (e) { threw = (e as Error).message.includes("not valid JSON"); }
ok("不正な JSON はエラー", threw);
threw = false;
try { parseAccountsConfig(JSON.stringify({ accounts: [] })); } catch { threw = true; }
ok("空のアカウント一覧はエラー", threw);
threw = false;
try { parseAccountsConfig(JSON.stringify({ accounts: [{ apiKey: "k" }] })); } catch { threw = true; }
ok("name 欠落はエラー", threw);
// apiKey は任意になった。省略したアカウントは、利用者本人のキーが渡された
// リクエストでのみ使える (src/core/credentials.ts)。設定時ではなく、
// キーが無いまま API を呼んだ時点で MissingCredentialError になる。
ok("apiKey 欠落は設定時には通る",
  parseAccountsConfig(JSON.stringify({ accounts: [{ name: "x" }] })).accounts[0].apiKey === undefined);

console.log("アカウントの解決:");
ok("既定を使う", resolveAccount(cfg).name === "main");
ok("名前で選ぶ", resolveAccount(cfg, "shared").name === "shared");
ok("大文字小文字を無視", resolveAccount(cfg, "SHARED").name === "shared");
threw = false;
try { resolveAccount(cfg, "nope"); } catch (e) { threw = (e as Error).message.includes("Available accounts"); }
ok("未知の名前はエラーで候補を出す", threw);

// fetch を差し替えて、実際に組み立てられた URL を観察する
let lastUrl = "";
let lastMethod = "";
const originalFetch = globalThis.fetch;
const stub = (body: string, status = 200, contentType = "application/json") =>
  ((input: any, init?: any) => {
    lastUrl = String(input); lastMethod = init?.method ?? "GET";
    return Promise.resolve(new Response(body, { status, headers: { "content-type": contentType } }));
  }) as typeof fetch;

console.log("URL の組み立て:");
globalThis.fetch = stub('{"ok":true}');
await callCacooApi(resolveAccount(cfg, "main"), { path: "diagrams.json", withOrganizationKey: true, query: { limit: 10 } });
const u = new URL(lastUrl);
ok("ベースパスは /api/v1", u.pathname === "/api/v1/diagrams.json");
ok("apiKey をクエリで送る", u.searchParams.get("apiKey") === "KEY-MAIN");
ok("organizationKey の既定を補う", u.searchParams.get("organizationKey") === "org-main");
ok("その他のクエリも載る", u.searchParams.get("limit") === "10");

await callCacooApi(resolveAccount(cfg, "main"), {
  path: "diagrams.json", withOrganizationKey: true, query: { organizationKey: "org-override" },
});
ok("引数の organizationKey が既定を上書き",
  new URL(lastUrl).searchParams.get("organizationKey") === "org-override");

await callCacooApi(resolveAccount(cfg, "main"), { path: "account.json", query: { a: undefined, b: null, c: 0 } });
const u2 = new URL(lastUrl);
ok("undefined / null は送らない", !u2.searchParams.has("a") && !u2.searchParams.has("b"));
ok("0 は送る", u2.searchParams.get("c") === "0");

await callCacooApi(resolveAccount(cfg, "onprem"), { path: "account.json" });
ok("baseUrl を尊重する", lastUrl.startsWith("https://cacoo.example.com/api/v1/"));

// oEmbed は /api/v1 の外にあり、認証不要 (apiKey を付けない)
await callCacooApi(resolveAccount(cfg, "main"), {
  path: "oembed.json", outsideApi: true, noAuth: true,
  query: { url: "https://cacoo.com/diagrams/x" },
});
const u3 = new URL(lastUrl);
ok("outsideApi は /api/v1 を付けない", u3.pathname === "/oembed.json");
ok("noAuth は apiKey を送らない", !u3.searchParams.has("apiKey"));
ok("oEmbed の url が載る", u3.searchParams.get("url") === "https://cacoo.com/diagrams/x");

// キー未設定のアカウントでも noAuth なら呼べる
const noKeyCfg = parseAccountsConfig(JSON.stringify({ accounts: [{ name: "nokey" }] }));
await callCacooApi(resolveAccount(noKeyCfg, "nokey"), {
  path: "oembed.json", outsideApi: true, noAuth: true,
});
ok("キー無しアカウントでも noAuth は通る", lastUrl.includes("/oembed.json"));
threw = false;
try { await callCacooApi(resolveAccount(noKeyCfg, "nokey"), { path: "diagrams.json" }); }
catch { threw = true; }
ok("キー無しアカウントの通常呼び出しは拒否される", threw);

console.log("readOnly ガード:");
await callCacooApi(resolveAccount(cfg, "shared"), { path: "diagrams.json" });
ok("読み取りは通る", lastMethod === "GET");

threw = false;
let err: unknown;
try {
  await callCacooApi(resolveAccount(cfg, "shared"), { method: "POST", path: "diagrams/create.json" });
} catch (e) { threw = true; err = e; }
ok("書き込みは拒否される", threw && err instanceof ReadOnlyAccountError);
ok("書き込み可のアカウントでは通る",
  await callCacooApi(resolveAccount(cfg, "main"), { method: "POST", path: "diagrams/create.json" })
    .then(() => true).catch(() => false));

console.log("応答の扱い:");
globalThis.fetch = stub("");
ok("空の本文は空オブジェクト",
  JSON.stringify(await callCacooApi(resolveAccount(cfg, "main"), { path: "x.json" })) === "{}");

globalThis.fetch = stub('{"errors":[{"message":"Not found","code":6,"moreInfo":"see docs"}]}', 404);
threw = false;
try { await callCacooApi(resolveAccount(cfg, "main"), { path: "x.json" }); } catch (e) { threw = true; err = e; }
ok("非 2xx は CacooApiError", threw && err instanceof CacooApiError);
ok("エラー本文を読める形にする",
  formatCacooError(err) === "Cacoo API error (HTTP 404): Not found code=6 see docs");

globalThis.fetch = stub("<html>oops</html>", 500, "text/html");
try { await callCacooApi(resolveAccount(cfg, "main"), { path: "x.json" }); } catch (e) { err = e; }
ok("JSON でない本文もそのまま出す", formatCacooError(err).includes("HTTP 500"));
ok("Error 以外も文字列化できる", formatCacooError("plain") === "plain");

console.log("画像:");
globalThis.fetch = ((_i: any, init?: any) => {
  lastMethod = init?.method ?? "GET";
  return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200, headers: { "content-type": "image/png" },
  }));
}) as typeof fetch;
const img = await callCacooApiBinary(resolveAccount(cfg, "main"), { path: "diagrams/x.png" });
ok("base64 で返す", img.base64 === btoa("\x01\x02\x03\x04"));
ok("mimeType を拾う", img.mimeType === "image/png");
ok("サイズを返す", img.size === 4);

globalThis.fetch = ((_i: any) => Promise.resolve(new Response(new Uint8Array(5 * 1024 * 1024), {
  status: 200, headers: { "content-type": "image/png" },
}))) as typeof fetch;
threw = false;
try { await callCacooApiBinary(resolveAccount(cfg, "main"), { path: "diagrams/x.png" }); }
catch (e) { threw = (e as Error).message.includes("exceeds"); }
ok("4MB 超はエラーにする", threw);

globalThis.fetch = originalFetch;
console.log(`\n${fail === 0 ? "OK" : "NG"} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
