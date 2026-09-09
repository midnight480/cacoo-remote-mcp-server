// 利用者本人の Cacoo API キーと organizationKey を受け取る層を検証する。
//
// このサーバはキーを保存しないため、「クライアントから運ばれてきた値を
// 正しく解析し、正しいアカウントにだけ適用し、間違いを黙って握りつぶさない」
// ことが安全性の中心になる。特に:
//   - 綴り違いのアカウント名で共有キーへフォールバックしないこと
//   - ある利用者のキーが元の設定オブジェクトに残らないこと
//   - キーが無い状態で API を呼ぼうとしたら手前で止まること
//   npm run test:credentials

import {
  applyUserCredentials, InvalidCredentialError, parseCredentialHeaders, parsePairList,
} from "../src/core/credentials.ts";
import {
  MissingCredentialError, parseAccountsConfig, resolveAccount, requireApiKey,
} from "../src/core/cacoo-client.ts";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`  ${c ? "OK " : "NG "} ${n}${e}`); c ? pass++ : fail++; };
const rejects = (n: string, fn: () => unknown) => {
  try { fn(); ok(n, false, " (通ってしまった)"); }
  catch (e) { ok(n, e instanceof InvalidCredentialError, e instanceof Error ? ` (${e.name})` : ""); }
};

const CONFIG = JSON.stringify({
  accounts: [
    { name: "WORK", apiKey: "server-work-key", organizationKey: "server-org" },
    { name: "TEAM" },
  ],
  defaultAccount: "WORK",
});
const BYO = JSON.stringify({ accounts: [], allowClientAccounts: true });

const headers = (h: Parameters<typeof parseCredentialHeaders>[0]) => parseCredentialHeaders(h);

console.log("ヘッダの解析:");
{
  const c = headers({ apiKeys: "WORK=k1,TEAM=k2", orgs: "WORK=o1" });
  ok("キーを分解する", c.keys?.work === "k1" && c.keys?.team === "k2");
  ok("組織を分解する", c.orgs?.work === "o1");
  ok("名前を小文字に正規化", parsePairList("Work=k", "h", "v").work === "k");
  ok("値の = を保つ", parsePairList("WORK=a=b", "h", "v").work === "a=b");
  ok("空エントリは無視", Object.keys(parsePairList("WORK=k,,", "h", "v")).length === 1);
}

console.log("不正な入力を拒否:");
rejects("= が無いエントリ", () => parsePairList("WORKk", "h", "v"));
rejects("同じアカウントの二重指定", () => parsePairList("WORK=a,work=b", "h", "v"));
rejects("空の値", () => parsePairList("WORK=", "h", "v"));
rejects("空白を含む値", () => headers({ apiKey: "a b" }));
rejects("制御文字を含む値", () => headers({ apiKey: "a\x01b" }));
rejects("非 ASCII を含む値", () => headers({ apiKey: "aあb" }));
rejects("長すぎる値", () => headers({ apiKey: "x".repeat(513) }));

console.log("設定への適用:");
{
  const base = parseAccountsConfig(CONFIG);
  ok("apiKey 無しのアカウントを許容", base.accounts[1].apiKey === undefined);

  const applied = applyUserCredentials(base, headers({ apiKeys: "WORK=mine,TEAM=mine2" }));
  ok("本人のキーが共有キーを上書き", resolveAccount(applied, "WORK").apiKey === "mine");
  ok("出所を user と記録", resolveAccount(applied, "WORK").keySource === "user");
  ok("キー未設定アカウントにも入る", resolveAccount(applied, "TEAM").apiKey === "mine2");
  ok("元の設定は書き換えない", resolveAccount(base, "WORK").apiKey === "server-work-key");

  const none = applyUserCredentials(base);
  ok("キー未指定なら共有キーのまま", resolveAccount(none, "WORK").apiKey === "server-work-key");
  ok("出所を server と記録", resolveAccount(none, "WORK").keySource === "server");
  ok("共有キーも無ければ未設定", resolveAccount(none, "TEAM").keySource === undefined);
}

console.log("organizationKey:");
{
  const base = parseAccountsConfig(CONFIG);
  const withOrg = applyUserCredentials(base, headers({ apiKeys: "WORK=k", orgs: "WORK=my-org" }));
  ok("本人の組織が設定側を上書き", resolveAccount(withOrg, "WORK").organizationKey === "my-org");
  ok("組織の出所を user と記録", resolveAccount(withOrg, "WORK").orgSource === "user");

  const noOrg = applyUserCredentials(base, headers({ apiKeys: "WORK=k" }));
  ok("組織未指定なら設定側のまま", resolveAccount(noOrg, "WORK").organizationKey === "server-org");
  ok("組織の出所を server と記録", resolveAccount(noOrg, "WORK").orgSource === "server");

  // 組織だけ渡してキーが無い場合。呼び出しは手前で止まる
  const orgOnly = applyUserCredentials(base, headers({ orgs: "TEAM=only-org" }));
  ok("組織だけでも設定される", resolveAccount(orgOnly, "TEAM").organizationKey === "only-org");
  ok("キーが無いことは変わらない", resolveAccount(orgOnly, "TEAM").apiKey === undefined);

  // 単数形ヘッダは既定アカウントに当たる
  const single = applyUserCredentials(base, headers({ apiKey: "k", org: "single-org" }));
  ok("単数形はデフォルトアカウントへ", resolveAccount(single, "WORK").organizationKey === "single-org");
  ok("他アカウントは据え置き", resolveAccount(single, "TEAM").organizationKey === undefined);
}

console.log("経路の優先順位:");
{
  const base = parseAccountsConfig(CONFIG);
  // 後の source が勝つ (ヘッダがトークンの封筒を上書きする)
  const merged = applyUserCredentials(
    base,
    headers({ apiKeys: "WORK=from-token", orgs: "WORK=org-token" }),
    headers({ apiKeys: "WORK=from-header" }),
  );
  ok("後の経路のキーが勝つ", resolveAccount(merged, "WORK").apiKey === "from-header");
  ok("上書きされない項目は残る", resolveAccount(merged, "WORK").organizationKey === "org-token");

  // 同一経路内での二重指定は暗黙に決めずエラー
  rejects("同一経路で単数と複数が衝突",
    () => applyUserCredentials(base, headers({ apiKey: "a", apiKeys: "WORK=b" })));
}

console.log("知らないアカウント名:");
{
  const base = parseAccountsConfig(CONFIG);
  // 綴り違いを黙って共有キーへ落とすと、本人のつもりで別人の権限で書く事故になる
  rejects("持ち込み不可の構成では拒否",
    () => applyUserCredentials(base, headers({ apiKeys: "TYPO=k" })));
}

console.log("アカウントの持ち込み:");
{
  const byo = parseAccountsConfig(BYO);
  ok("アカウント 0 個でも通る", byo.accounts.length === 0);
  ok("既定アカウントは空", byo.defaultAccount === "");

  const cfg = applyUserCredentials(byo, headers({ apiKeys: "MINE=my-key", orgs: "MINE=my-org" }));
  ok("アカウントが増える", cfg.accounts.length === 1);
  ok("キーが入る", resolveAccount(cfg, "MINE").apiKey === "my-key");
  ok("組織が入る", resolveAccount(cfg, "MINE").organizationKey === "my-org");
  ok("最初のものが既定になる", cfg.defaultAccount === "mine");
  ok("書き込み可", resolveAccount(cfg, "MINE").readOnly === false);
  // 宛先は常にサーバ側が決める。クライアントは接続先を動かせない。
  ok("baseUrl は既定値", resolveAccount(cfg, "MINE").baseUrl === "https://cacoo.com");

  rejectsConfig("アカウント 0 個で allowClientAccounts 無しは拒否", '{"accounts":[]}');
  function rejectsConfig(n: string, json: string) {
    try { parseAccountsConfig(json); ok(n, false, " (通ってしまった)"); }
    catch { ok(n, true); }
  }
}

console.log("キーが無いまま呼んだとき:");
{
  const none = applyUserCredentials(parseAccountsConfig(CONFIG));
  try {
    requireApiKey(resolveAccount(none, "TEAM"));
    ok("API 呼び出し前に止まる", false, " (例外が出なかった)");
  } catch (e) {
    ok("API 呼び出し前に止まる", e instanceof MissingCredentialError);
    ok("設定方法を案内する", e instanceof Error && e.message.includes("X-Cacoo-Api-Key"));
  }
}

console.log("\n" + (fail ? "NG" : "OK") + ` pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
