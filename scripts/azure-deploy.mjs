#!/usr/bin/env node
// Microsoft Azure (Container Apps) へビルドとデプロイを行う。
//
//   node scripts/azure-deploy.mjs [--group <rg>] [--location <region>] [--skip-build] [--what-if]
//
// コンテナを Azure Container Registry へ push してから Bicep をデプロイする。
// --what-if を付けると差分だけを表示し、何も作らない。
// リージョンの既定は japaneast。AWS / GCP 版と同じく
// 引数 > 環境変数 > 既定値 の順で解決する。

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BICEP = "infra/azure/main.bicep";
const PARAMS = join(ROOT, "infra/azure/params.json");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : argv[i + 1];
};
const SKIP_BUILD = argv.includes("--skip-build");
// 変更を適用せず差分だけ見る
const WHAT_IF = argv.includes("--what-if");
const LOCATION = flag("--location", process.env.AZURE_LOCATION || "japaneast");

function readParams() {
	if (!existsSync(PARAMS)) {
		throw new Error(
			`${PARAMS} がありません。\n` +
				"  infra/azure/params.example.json を複製して値を埋めてください。",
		);
	}
	const doc = JSON.parse(readFileSync(PARAMS, "utf8"));
	const out = {};
	for (const [k, v] of Object.entries(doc.parameters ?? {})) out[k] = v.value;
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
	const params = readParams();
	const group = flag("--group", process.env.AZURE_RESOURCE_GROUP);
	if (!group) {
		throw new Error(
			"リソースグループを解決できません。--group か AZURE_RESOURCE_GROUP で指定してください。",
		);
	}

	const image = params.image;
	if (!image) throw new Error("params.json に image がありません。");

	// image のレジストリと registryServer が食い違うと pull できない
	const registry = params.registryServer;
	if (registry && !image.startsWith(`${registry}/`)) {
		throw new Error(
			`レジストリが食い違っています。\n` +
				`   image          : ${image}\n` +
				`   registryServer : ${registry}\n` +
				`  params.json のどちらかを揃えてください。`,
		);
	}

	console.log(`リソースグループ: ${group} (${LOCATION})`);

	if (!SKIP_BUILD && !WHAT_IF) {
		if (!registry) {
			throw new Error(
				"registryServer が空です。イメージを自分で push するなら --skip-build を付けてください。",
			);
		}
		// ACR 上でビルドして push する (ローカルに docker が無くても動く)
		run("az", [
			"acr", "build",
			"--registry", registry.replace(/\.azurecr\.io$/, ""),
			"--image", image.slice(registry.length + 1),
			"--file", "src/platforms/azure/Dockerfile",
			".",
		]);
	}

	const args = [
		"deployment", "group", WHAT_IF ? "what-if" : "create",
		"--resource-group", group,
		"--template-file", BICEP,
		"--parameters", `@${PARAMS}`,
	];
	run("az", args);
}

try {
	main();
} catch (e) {
	console.error(`✘ ${e && e.message ? e.message : e}`);
	process.exit(1);
}
