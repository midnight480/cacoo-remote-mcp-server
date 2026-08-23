#!/usr/bin/env node
// AWS (SAM) へビルドとデプロイをまとめて実行する。
//
//   node scripts/aws-deploy.mjs [--stack <name>] [--region <region>] [--skip-build]
//
// リージョンを明示するために存在する。素の `sam deploy` は --region が無いと
// AWS プロファイルの既定リージョンへ向かってしまい、別リージョンに二つ目の
// スタックを作るか、証明書のリージョン不一致で失敗する。既定を
// ap-northeast-1 に固定しつつ、--region と AWS_REGION で上書きできるように
// する (aws-push-secrets.mjs / aws-request-cert.mjs と同じ優先順位)。

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
const SKIP_BUILD = argv.includes("--skip-build");

const TEMPLATE = "infra/aws/template.yaml";
const BUILT_TEMPLATE = ".aws-sam/build/template.yaml";
const PARAMS_REL = "infra/aws/params.yaml";
const PARAMS = join(ROOT, PARAMS_REL);

/** params.yaml から `Key: 'value'` 形式を読む (シングルクォート必須) */
function readParams() {
	const text = readFileSync(PARAMS, "utf8");
	const out = {};
	for (const line of text.split("\n")) {
		const m = /^(\w+):\s*'(.*)'\s*$/.exec(line.trim());
		if (m) out[m[1]] = m[2];
	}
	return out;
}

/**
 * ACM 証明書はリージョンをまたいで使えない。ARN のリージョンとデプロイ先が
 * 食い違ったまま進むと CloudFormation の途中で失敗するので、先に止める。
 */
function assertCertRegion(params) {
	const arn = params.AcmCertificateArn;
	if (!arn) return;
	const m = /^arn:aws[^:]*:acm:([^:]+):/.exec(arn);
	if (!m) {
		console.error(`✘ AcmCertificateArn の形式が読めません: ${arn}`);
		process.exit(1);
	}
	if (m[1] !== REGION) {
		console.error(
			`✘ リージョンが食い違っています。\n` +
				`   デプロイ先          : ${REGION}\n` +
				`   証明書 (params.yaml): ${m[1]}\n` +
				`  ACM 証明書は他リージョンから参照できません。--region ${m[1]} を指定するか、\n` +
				`  infra/aws/params.yaml の AcmCertificateArn を ${REGION} の証明書に差し替えてください。`,
		);
		process.exit(1);
	}
}

function run(cmd, args) {
	console.log(`$ ${cmd} ${args.join(" ")}`);
	try {
		execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT });
	} catch (e) {
		// sam 自身が既にエラーを出しているので、Node のスタックは足さずに終了コードだけ引き継ぐ
		process.exit(typeof e.status === "number" ? e.status : 1);
	}
}

function main() {
	assertCertRegion(readParams());
	console.log(`スタック: ${STACK} (${REGION})`);

	if (!SKIP_BUILD) {
		run("sam", ["build", "--template", TEMPLATE]);
	}

	run("sam", [
		"deploy",
		"--template-file",
		BUILT_TEMPLATE,
		"--stack-name",
		STACK,
		"--region",
		REGION,
		"--capabilities",
		"CAPABILITY_IAM",
		"--resolve-s3",
		"--no-confirm-changeset",
		"--no-fail-on-empty-changeset",
		"--parameter-overrides",
		`file://${PARAMS_REL}`,
	]);

	// デプロイ先のドメインを埋めた .mcpb を作る。ここでの失敗はデプロイ自体を
	// 巻き戻すものではないので --soft-fail で警告に留める。
	run("node", ["scripts/build-mcpb.mjs", "--soft-fail"]);
}

main();
