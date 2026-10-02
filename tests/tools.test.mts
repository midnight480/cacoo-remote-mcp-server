// ツール登録の検証。
// 18 ツールが漏れなく登録されること、許可リスト外のユーザーには
// access_denied しか見えないことを確認する。
//   npm run test:tools

import { createMcpServer } from "../src/core/create-server.ts";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`  ${c ? "OK " : "NG "} ${n}${e}`); c ? pass++ : fail++; };

const ACCOUNTS = JSON.stringify({
  accounts: [{ name: "main", apiKey: "KEY", organizationKey: "org" }],
  defaultAccount: "main",
});

/** McpServer の内部に登録されたツール名を取り出す */
function toolNames(server: any): string[] {
  const reg = server._registeredTools ?? server.server?._registeredTools ?? {};
  return Object.keys(reg).sort();
}

const EXPECTED = [
  // diagram
  "copy_diagram", "create_diagram", "delete_diagram", "get_diagram",
  "get_diagram_contents", "get_diagram_image", "get_editor_token",
  "get_inserted_image", "get_oembed", "list_diagrams", "move_diagram",
  "register_editor_automation",
  // workspace
  "get_account", "get_license", "get_user", "list_accounts", "list_folders",
  "list_organizations",
].sort();

console.log("許可リストなし (全員通す):");
const open = toolNames(createMcpServer({ accountsConfig: ACCOUNTS }));
ok(`ツール数 ${open.length}`, open.length === EXPECTED.length,
  open.length === EXPECTED.length ? "" : `  期待 ${EXPECTED.length}: ${open.join(", ")}`);
ok("顔ぶれが一致", JSON.stringify(open) === JSON.stringify(EXPECTED),
  JSON.stringify(open) === JSON.stringify(EXPECTED) ? "" : `\n     実際: ${open.join(", ")}`);
ok("access_denied は出ない", !open.includes("access_denied"));

console.log("許可リストあり:");
const allowed = toolNames(createMcpServer({
  accountsConfig: ACCOUNTS, allowedEmails: '["me@example.com"]', userEmail: "me@example.com",
}));
ok("許可されたユーザーには全ツール", allowed.length === EXPECTED.length);

const denied = toolNames(createMcpServer({
  accountsConfig: ACCOUNTS, allowedEmails: '["me@example.com"]', userEmail: "other@example.com",
}));
ok("許可外は access_denied のみ",
  denied.length === 1 && denied[0] === "access_denied", `  実際: ${denied.join(", ")}`);

const upper = toolNames(createMcpServer({
  accountsConfig: ACCOUNTS, allowedEmails: '["Me@Example.com"]', userEmail: "me@example.com",
}));
ok("メール比較は大文字小文字を無視", upper.length === EXPECTED.length);

const noEmail = toolNames(createMcpServer({
  accountsConfig: ACCOUNTS, allowedEmails: '["me@example.com"]',
}));
ok("未認証は拒否される", noEmail.length === 1 && noEmail[0] === "access_denied");

const badList = toolNames(createMcpServer({
  accountsConfig: ACCOUNTS, allowedEmails: "{ broken", userEmail: "me@example.com",
}));
ok("壊れた許可リストは制限なし扱い", badList.length === EXPECTED.length);

console.log(`\n${fail === 0 ? "OK" : "NG"} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
