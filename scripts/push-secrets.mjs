#!/usr/bin/env node
// .dev.vars の値を Cloudflare Workers のシークレットとして登録する。
//
//   node scripts/push-secrets.mjs [--dry-run]
//
// 登録対象は wrangler.jsonc の secrets.required に列挙されたキーのみ。
// MCP_HOSTNAME のようなビルド時専用の値は Worker に送らない。
// 値は wrangler の stdin に直接渡し、平文の一時ファイルを作らない。

import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripJsonc } from "./build-deploy-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_VARS = join(ROOT, ".dev.vars");
const DEPLOY_CONFIG = join(ROOT, "wrangler.deploy.json");
const DRY_RUN = process.argv.includes("--dry-run");

function parseDevVars(text) {
	const vars = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		// 引用符で囲まれている場合のみ剥がす。JSON 値をそのまま扱えるようにする。
		let value = trimmed.slice(eq + 1);
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		vars[key] = value;
	}
	return vars;
}

function main() {
	if (!existsSync(DEV_VARS)) {
		console.error("✘ .dev.vars が見つかりません。");
		process.exit(1);
	}
	const config = JSON.parse(stripJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")));
	const required = config.secrets?.required;
	if (!Array.isArray(required) || required.length === 0) {
		console.error("✘ wrangler.jsonc の secrets.required が空です。");
		process.exit(1);
	}

	const vars = parseDevVars(readFileSync(DEV_VARS, "utf8"));
	const payload = {};
	const missing = [];
	const placeholder = [];
	for (const key of required) {
		const value = vars[key];
		if (value === undefined || value === "") {
			missing.push(key);
			continue;
		}
		if (value.includes("<TODO") || value.includes("your-")) {
			placeholder.push(key);
			continue;
		}
		payload[key] = value;
	}

	if (missing.length || placeholder.length) {
		if (missing.length) console.error(`✘ .dev.vars に未定義: ${missing.join(", ")}`);
		if (placeholder.length)
			console.error(`✘ プレースホルダのまま: ${placeholder.join(", ")}`);
		process.exit(1);
	}

	// 送らないキー (ビルド時専用など) を明示して取り違えを防ぐ
	const skipped = Object.keys(vars).filter((k) => !required.includes(k));

	console.log(`Worker: ${config.name}`);
	console.log("登録するシークレット (値は表示しません):");
	for (const key of Object.keys(payload)) console.log(`  - ${key} (${payload[key].length} 文字)`);
	if (skipped.length) console.log(`送信しないキー: ${skipped.join(", ")}`);

	if (DRY_RUN) {
		console.log("\n--dry-run のため送信しません。");
		return;
	}

	const args = ["wrangler", "secret", "bulk"];
	if (existsSync(DEPLOY_CONFIG)) args.push("--config", DEPLOY_CONFIG);
	const child = spawn("npx", args, { cwd: ROOT, stdio: ["pipe", "inherit", "inherit"] });
	child.stdin.end(JSON.stringify(payload));
	child.on("exit", (code) => process.exit(code ?? 1));
}

main();
