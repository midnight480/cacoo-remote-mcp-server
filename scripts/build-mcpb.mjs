#!/usr/bin/env node
// デプロイ先のドメインを埋め込んだ .mcpb (MCP Bundle) を生成する。
//
//   node scripts/build-mcpb.mjs [--host <hostname>] [--out <dir>] [--soft-fail]
//
// MCPB はローカル実行専用の形式で、manifest の server.type は
// node / python / binary / uv しかない。リモート (HTTP + OAuth) の MCP サーバを
// 直接指す型は存在しないため、mcp-remote を stdio プロキシとして同梱し、
// そこからこのサーバへ繋ぐ構成にする。README に書いてある Claude Desktop 向けの
// 手動 JSON 設定を、ワンクリックインストールに置き換えるもの。
//
// ホスト名は user_config で上書きできる。既定値だけをデプロイ先から埋めるので、
// フォークした人は自分のデプロイ先を入力すればそのまま使える。
//
// 注意: Claude Code はこのバンドルを使わない (claude mcp add --transport http のまま)。
// 配布対象は Claude Desktop など MCPB 対応クライアント。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : argv[i + 1];
};
// デプロイの後段で呼ばれたときは、パッケージング失敗でデプロイ全体を
// 失敗扱いにしたくない (デプロイ自体は既に成功しているため)。
const SOFT_FAIL = argv.includes("--soft-fail");
const OUT_DIR = flag("--out", join(ROOT, "dist"));

const BUILD_DIR = join(ROOT, ".mcpb-build");
const MCP_REMOTE_VERSION = "0.1.43";

/** infra/aws/params.yaml から `Key: 'value'` 形式を読む */
function readAwsParams() {
	try {
		const text = readFileSync(join(ROOT, "infra/aws/params.yaml"), "utf8");
		const out = {};
		for (const line of text.split("\n")) {
			const m = /^(\w+):\s*'(.*)'\s*$/.exec(line.trim());
			if (m) out[m[1]] = m[2];
		}
		return out;
	} catch {
		return {};
	}
}

/** .dev.vars から KEY=value を読む (Cloudflare 側のホスト解決に使う) */
function readDevVar(name) {
	try {
		const text = readFileSync(join(ROOT, ".dev.vars"), "utf8");
		for (const line of text.split("\n")) {
			const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
			if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, "");
		}
	} catch {
		// .dev.vars が無いのは正常
	}
	return undefined;
}

/**
 * ホスト名の解決順:
 *   1. --host 引数
 *   2. MCP_HOSTNAME 環境変数 (Cloudflare デプロイと同じ変数)
 *   3. infra/aws/params.yaml の ApiDomainName (AWS デプロイ)
 *   4. .dev.vars の MCP_HOSTNAME
 */
function resolveHost() {
	const fromFlag = flag("--host");
	if (fromFlag) return { host: fromFlag, source: "--host 引数" };
	if (process.env.MCP_HOSTNAME)
		return { host: process.env.MCP_HOSTNAME, source: "MCP_HOSTNAME 環境変数" };
	const aws = readAwsParams();
	if (aws.ApiDomainName)
		return { host: aws.ApiDomainName, source: "infra/aws/params.yaml の ApiDomainName" };
	const dev = readDevVar("MCP_HOSTNAME");
	if (dev) return { host: dev, source: ".dev.vars の MCP_HOSTNAME" };
	return {};
}

function buildManifest(host) {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const proxy = "server/node_modules/mcp-remote/dist/proxy.js";
	return {
		manifest_version: "0.2",
		name: "cacoo-remote-mcp-server",
		display_name: "Cacoo Remote MCP Server",
		version: pkg.version,
		description:
			"Connects Claude to a self-hosted Cacoo Remote MCP Server, exposing diagrams, folders and account information as 18 tools.",
		long_description:
			"This bundle does not contain the server itself. It ships mcp-remote as a local stdio proxy " +
			"that connects to your own deployment of cacoo-remote-mcp-server (Cloudflare Workers, AWS Lambda, Cloud Run or Container Apps). " +
			"Authentication happens in the browser via OAuth on first connection. " +
			"Set the endpoint URL below to your own deployment if you are not using the default.",
		author: { name: "midnight480", url: "https://github.com/midnight480" },
		homepage: "https://github.com/midnight480/cacoo-remote-mcp-server",
		documentation: "https://github.com/midnight480/cacoo-remote-mcp-server#readme",
		repository: {
			type: "git",
			url: "https://github.com/midnight480/cacoo-remote-mcp-server",
		},
		license: pkg.license || "MIT",
		keywords: ["cacoo", "nulab", "diagram", "remote", "oauth"],
		user_config: {
			mcp_url: {
				type: "string",
				title: "MCP endpoint URL",
				description:
					"URL of your deployed Cacoo Remote MCP Server, including the /mcp path. " +
					"The default points at the deployment this bundle was built from.",
				default: `https://${host}/mcp`,
				required: true,
			},
		},
		server: {
			type: "node",
			entry_point: proxy,
			mcp_config: {
				command: "node",
				args: [`\${__dirname}/${proxy}`, "${user_config.mcp_url}"],
				env: {},
			},
		},
	};
}

function run(cmd, args, cwd) {
	execFileSync(cmd, args, { stdio: "inherit", cwd: cwd || ROOT });
}

function main() {
	const { host, source } = resolveHost();
	if (!host) {
		throw new Error(
			"ホスト名を解決できませんでした。--host を指定するか、MCP_HOSTNAME を設定するか、\n" +
				"infra/aws/params.yaml に ApiDomainName を設定してください。",
		);
	}
	console.log(`MCPB を生成します: https://${host}/mcp  (${source})`);

	rmSync(BUILD_DIR, { recursive: true, force: true });
	mkdirSync(join(BUILD_DIR, "server"), { recursive: true });

	// mcp-remote をバンドルへ同梱する。実行時に npx でネットワークを叩かせない。
	writeFileSync(
		join(BUILD_DIR, "server", "package.json"),
		`${JSON.stringify(
			{
				name: "cacoo-remote-mcp-server-proxy",
				version: "1.0.0",
				private: true,
				dependencies: { "mcp-remote": MCP_REMOTE_VERSION },
			},
			null,
			2,
		)}\n`,
	);
	console.log(`mcp-remote@${MCP_REMOTE_VERSION} を同梱します`);
	run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], join(BUILD_DIR, "server"));

	const manifest = buildManifest(host);
	writeFileSync(join(BUILD_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	const proxyPath = join(BUILD_DIR, manifest.server.entry_point);
	if (!existsSync(proxyPath)) {
		throw new Error(`mcp-remote の proxy が見つかりません: ${manifest.server.entry_point}`);
	}

	const mcpb = ["-y", "@anthropic-ai/mcpb@latest"];
	run("npx", [...mcpb, "validate", join(BUILD_DIR, "manifest.json")]);

	mkdirSync(OUT_DIR, { recursive: true });
	const out = join(OUT_DIR, `cacoo-remote-mcp-server-${manifest.version}.mcpb`);
	run("npx", [...mcpb, "pack", BUILD_DIR, out]);

	rmSync(BUILD_DIR, { recursive: true, force: true });
	console.log(`\n生成しました: ${out}`);
}

try {
	main();
} catch (e) {
	const msg = e && e.message ? e.message : String(e);
	if (SOFT_FAIL) {
		// デプロイ自体は成功しているので、ここでは警告に留める
		console.warn(`\n⚠ MCPB の生成に失敗しました (デプロイは成功しています): ${msg}`);
		console.warn("  あとで npm run mcpb:pack を実行してください。");
		process.exit(0);
	}
	console.error(`✘ ${msg}`);
	process.exit(1);
}
