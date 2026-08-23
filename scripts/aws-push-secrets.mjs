#!/usr/bin/env node
// infra/aws/params.yaml の機密値を Secrets Manager へ反映する。
//
//   node scripts/aws-push-secrets.mjs [--stack <name>] [--region <region>] [--dry-run]
//
// npm run aws:deploy でもデプロイの過程で登録されるが、コードを触らずに
// シークレットだけ差し替えたいときはこちらを使う (Cloudflare 側の
// secrets:push と同じ位置づけ)。
// 値は表示せず、名前と文字数だけを出す。

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : argv[i + 1];
};
const STACK = flag("--stack", "cacoo-mcp-aws");
const REGION = flag("--region", process.env.AWS_REGION || "ap-northeast-1");
const DRY_RUN = argv.includes("--dry-run");

/** params.yaml から `Key: 'value'` 形式を読む (シングルクォート必須) */
function readParams() {
	const text = readFileSync(join(ROOT, "infra/aws/params.yaml"), "utf8");
	const out = {};
	for (const line of text.split("\n")) {
		const m = /^(\w+):\s*'(.*)'\s*$/.exec(line.trim());
		if (m) out[m[1]] = m[2];
	}
	return out;
}

// params.yaml のキー -> Secrets Manager の論理名
const MAPPING = [{ param: "CacooAccountsConfig", suffix: "cacoo-accounts-config" }];

function main() {
	const params = readParams();
	const targets = [];
	for (const { param, suffix } of MAPPING) {
		const value = params[param];
		if (!value) {
			console.error(`✘ infra/aws/params.yaml に ${param} がありません`);
			process.exit(1);
		}
		if (value.includes("<TODO") || value.includes("your-") || value.includes('"xxx"')) {
			console.error(`✘ ${param} がプレースホルダのままです`);
			process.exit(1);
		}
		targets.push({ secretId: `${STACK}/${suffix}`, value, param });
	}

	console.log(`スタック: ${STACK} (${REGION})`);
	console.log("更新するシークレット (値は表示しません):");
	for (const t of targets) console.log(`  - ${t.secretId}  <- ${t.param} (${t.value.length} 文字)`);
	console.log(
		"Secrets Manager が管理する Cognito の client secret は AWS が生成するため対象外です。",
	);

	if (DRY_RUN) {
		console.log("\n--dry-run のため送信しません。");
		return;
	}

	for (const t of targets) {
		// 値は argv ではなく stdin 相当の file:// 経由にできないため、
		// --secret-string に渡す。プロセス一覧に見える可能性がある点は
		// aws CLI の制約。気になる場合は npm run aws:deploy を使う。
		execFileSync(
			"aws",
			[
				"secretsmanager",
				"put-secret-value",
				"--secret-id",
				t.secretId,
				"--secret-string",
				t.value,
				"--region",
				REGION,
			],
			{ stdio: ["ignore", "ignore", "inherit"] },
		);
		console.log(`  ✔ ${t.secretId} を更新しました`);
	}
}

main();
