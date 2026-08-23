#!/usr/bin/env node
// Google Cloud (Cloud Run) へビルドとデプロイを行う。
//
//   node scripts/gcp-deploy.mjs [--project <id>] [--region <region>] [--skip-build] [--plan]
//
// --plan を付けると terraform plan だけを実行し、何も作らない。
//
// コンテナを Artifact Registry へ push してから terraform apply する。
// リージョンの既定は asia-northeast1。AWS 版と同じく
// 引数 > 環境変数 > 既定値 の順で解決する。

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TF_DIR = join(ROOT, "infra/gcp");
const TFVARS = join(TF_DIR, "terraform.tfvars");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : argv[i + 1];
};
const SKIP_BUILD = argv.includes("--skip-build");
// 変更を適用せず差分だけ見る
const PLAN_ONLY = argv.includes("--plan");
const REGION = flag("--region", process.env.GOOGLE_CLOUD_REGION || "asia-northeast1");

/** terraform.tfvars から `key = "value"` を読む */
function readTfvars() {
	if (!existsSync(TFVARS)) {
		throw new Error(
			`${TFVARS} がありません。\n` +
				"  infra/gcp/terraform.tfvars.example を複製して値を埋めてください。",
		);
	}
	const out = {};
	for (const line of readFileSync(TFVARS, "utf8").split("\n")) {
		const m = /^\s*([a-z_]+)\s*=\s*"(.*)"\s*$/.exec(line);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

function run(cmd, args, cwd) {
	console.log(`$ ${cmd} ${args.join(" ")}`);
	try {
		execFileSync(cmd, args, { stdio: "inherit", cwd: cwd || ROOT });
	} catch (e) {
		// 実行したコマンドが既にエラーを出しているので終了コードだけ引き継ぐ
		process.exit(typeof e.status === "number" ? e.status : 1);
	}
}

function main() {
	const vars = readTfvars();
	const project = flag("--project", process.env.GOOGLE_CLOUD_PROJECT || vars.project_id);
	if (!project) {
		throw new Error("project_id を解決できません。--project か terraform.tfvars で指定してください。");
	}
	const image = vars.image;
	if (!image) {
		throw new Error("terraform.tfvars に image がありません。");
	}
	// image のリージョンとデプロイ先が食い違うと push 先を間違える
	const imageRegion = /^([a-z0-9-]+)-docker\.pkg\.dev\//.exec(image)?.[1];
	if (imageRegion && imageRegion !== REGION) {
		throw new Error(
			`リージョンが食い違っています。\n` +
				`   デプロイ先            : ${REGION}\n` +
				`   image (tfvars)        : ${imageRegion}\n` +
				`  --region を合わせるか、terraform.tfvars の image を差し替えてください。`,
		);
	}

	console.log(`プロジェクト: ${project} (${REGION})`);

	if (!SKIP_BUILD && !PLAN_ONLY) {
		// Cloud Build でイメージを作って Artifact Registry へ push する
		run("gcloud", [
			"builds", "submit",
			"--project", project,
			"--region", REGION,
			"--tag", image,
			"--file", "src/platforms/gcp/Dockerfile",
			".",
		]);
	}

	run("terraform", ["init", "-input=false"], TF_DIR);
	if (PLAN_ONLY) {
		run("terraform", ["plan", "-input=false", `-var=region=${REGION}`], TF_DIR);
		return;
	}
	run("terraform", ["apply", "-input=false", "-auto-approve", `-var=region=${REGION}`], TF_DIR);
}

try {
	main();
} catch (e) {
	console.error(`✘ ${e && e.message ? e.message : e}`);
	process.exit(1);
}
