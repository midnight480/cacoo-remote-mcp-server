// 利用者本人のキーと organizationKey が、ツール呼び出しを通って実際に
// Cacoo への発信リクエストへ乗るところまでを通しで検証する。
//
// credentials.test.mts が見ているのは解析と重ね合わせまでで、「MCP のツールを
// 実際に呼んだとき、そのリクエストで指定した値が Cacoo に届くか」は
// 組み立て側の問題として残る。ここではその 1 本を確かめる。
//
// ここで組み立てる server + transport は、各プラットフォームの入口
// (src/oauth/app.ts と src/platforms/cloudflare/index.ts) がリクエストごとに
// 作っているものと同じ。ヘッダから UserCredentials への変換だけが実行環境側に
// あり、それは credentials.test.mts が見ている。
//   npm run test:user-credentials

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "../src/core/create-server.ts";
import { parseCredentialHeaders } from "../src/core/credentials.ts";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`  ${c ? "OK " : "NG "} ${n}${e}`); c ? pass++ : fail++; };

const ACCOUNTS = JSON.stringify({
  accounts: [
    { name: "WORK" },
    { name: "SHARED", apiKey: "server-shared-key", organizationKey: "server-org" },
  ],
  defaultAccount: "WORK",
});
const ALLOWED = JSON.stringify(["user@example.com"]);

/** Cacoo への発信を捕まえ、実際には飛ばさない */
function stubCacoo() {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    urls.push(typeof input === "string" ? input : input.url ?? String(input));
    return new Response(JSON.stringify({ result: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

/** 各プラットフォームの /mcp と同じ手順でツールを 1 回呼ぶ */
async function callTool(opts: {
  tool: string;
  args?: Record<string, unknown>;
  headers?: Parameters<typeof parseCredentialHeaders>[0];
  accountsConfig?: string;
  userEmail?: string;
}) {
  const server = createMcpServer({
    accountsConfig: opts.accountsConfig ?? ACCOUNTS,
    allowedEmails: ALLOWED,
    userEmail: opts.userEmail ?? "user@example.com",
    userCredentials: parseCredentialHeaders(opts.headers ?? {}),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const stub = stubCacoo();
  try {
    const res = await transport.handleRequest(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: opts.tool, arguments: opts.args ?? {} },
        }),
      }),
    );
    return { urls: stub.urls, body: await res.json() as any };
  } finally {
    stub.restore();
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

const paramOf = (urls: string[], name: string) =>
  urls.length ? new URL(urls[0]).searchParams.get(name) : null;
const bodyText = (b: unknown) => JSON.stringify(b);

console.log("ヘッダのキーが Cacoo まで届くか:");
{
  const r = await callTool({
    tool: "list_diagrams",
    args: { account: "WORK" },
    headers: { apiKeys: "WORK=my-own-key" },
  });
  ok("Cacoo を 1 回呼ぶ", r.urls.length === 1, ` (${r.urls.length} 回)`);
  ok("本人のキーが渡る", paramOf(r.urls, "apiKey") === "my-own-key", ` (${paramOf(r.urls, "apiKey")})`);
}

console.log("組織キーが Cacoo まで届くか:");
{
  const r = await callTool({
    tool: "list_diagrams",
    args: { account: "WORK" },
    headers: { apiKeys: "WORK=my-own-key", orgs: "WORK=my-own-org" },
  });
  ok("本人の組織が渡る", paramOf(r.urls, "organizationKey") === "my-own-org",
    ` (${paramOf(r.urls, "organizationKey")})`);
}
{
  // ツール引数は既定値より優先される (従来どおりの挙動)
  const r = await callTool({
    tool: "list_diagrams",
    args: { account: "WORK", organizationKey: "per-call-org" },
    headers: { apiKeys: "WORK=k", orgs: "WORK=header-org" },
  });
  ok("ツール引数が既定より優先", paramOf(r.urls, "organizationKey") === "per-call-org",
    ` (${paramOf(r.urls, "organizationKey")})`);
}

console.log("ヘッダを送らない場合:");
{
  const r = await callTool({ tool: "list_diagrams", args: { account: "SHARED" } });
  ok("設定の共有キーを使う", paramOf(r.urls, "apiKey") === "server-shared-key");
  ok("設定の組織を使う", paramOf(r.urls, "organizationKey") === "server-org");
}

console.log("キーがどこにも無いアカウント:");
{
  const r = await callTool({ tool: "list_diagrams", args: { account: "WORK" } });
  ok("Cacoo を呼ばない", r.urls.length === 0, ` (${r.urls.length} 回)`);
  ok("設定方法を案内する", bodyText(r.body).includes("X-Cacoo-Api-Key"),
    ` ${bodyText(r.body).slice(0, 120)}`);
}

console.log("アカウントの持ち込み:");
{
  const BYO = JSON.stringify({ accounts: [], allowClientAccounts: true });
  const r = await callTool({
    tool: "list_diagrams",
    args: { account: "MINE" },
    accountsConfig: BYO,
    headers: { apiKeys: "MINE=my-key", orgs: "MINE=my-org" },
  });
  ok("持ち込んだアカウントで呼べる", r.urls.length === 1, ` (${r.urls.length} 回)`);
  ok("宛先は既定のホスト", r.urls[0]?.startsWith("https://cacoo.com/api/v1/"), ` (${r.urls[0]})`);
  ok("キーと組織が渡る",
    paramOf(r.urls, "apiKey") === "my-key" && paramOf(r.urls, "organizationKey") === "my-org");
}

console.log("キーは応答に漏れないか:");
{
  const r = await callTool({
    tool: "list_accounts",
    headers: { apiKeys: "WORK=my-own-key", orgs: "WORK=my-own-org" },
  });
  ok("list_accounts にキーの値が出ない", !bodyText(r.body).includes("my-own-key"));
}

console.log("認可されていない利用者:");
{
  const r = await callTool({
    tool: "list_diagrams",
    headers: { apiKeys: "WORK=my-own-key" },
    userEmail: "intruder@example.com",
  });
  ok("Cacoo を呼ばない", r.urls.length === 0, ` (${r.urls.length} 回)`);
}

console.log("\n" + (fail ? "NG" : "OK") + ` pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
