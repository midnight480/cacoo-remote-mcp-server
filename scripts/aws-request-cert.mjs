#!/usr/bin/env node
// Route 53 以外で DNS を管理している場合に、ACM 証明書を発行して検証を待つ。
//
//   node scripts/aws-request-cert.mjs --domain cacoo-mcp.example.com [--region ap-northeast-1]
//
// Route 53 にゾーンがある場合はこのスクリプトは不要。params.yaml の
// HostedZoneId を設定すれば、証明書の発行・検証・A レコード作成まで
// CloudFormation が自動で行う。
//
// 動作:
//   1. 既に同じドメインの ISSUED / PENDING_VALIDATION 証明書があれば再利用
//   2. 無ければ DNS 検証で発行をリクエスト
//   3. 検証用 CNAME を表示 (これを DNS に登録する)
//   4. 検証完了までポーリングし、完了したら ARN を表示

import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const DOMAIN = flag("--domain");
const REGION = flag("--region", process.env.AWS_REGION || "ap-northeast-1");
const TIMEOUT_MIN = Number(flag("--timeout-min", 30));

if (!DOMAIN) {
	console.error("✘ --domain が必要です  例: --domain cacoo-mcp.example.com");
	process.exit(1);
}

const aws = (args) =>
	JSON.parse(
		execFileSync("aws", [...args, "--region", REGION, "--output", "json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		}) || "null",
	);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findExisting() {
	const res = aws(["acm", "list-certificates", "--certificate-statuses", "ISSUED", "PENDING_VALIDATION"]);
	return (res?.CertificateSummaryList ?? []).find((c) => c.DomainName === DOMAIN)?.CertificateArn;
}

async function main() {
	let arn = findExisting();
	if (arn) {
		console.log(`既存の証明書を使います: ${arn}`);
	} else {
		console.log(`証明書を発行します: ${DOMAIN} (${REGION})`);
		arn = aws([
			"acm", "request-certificate",
			"--domain-name", DOMAIN,
			"--validation-method", "DNS",
			"--key-algorithm", "RSA_2048",
		]).CertificateArn;
		console.log(`  ARN: ${arn}`);
		await sleep(5000);
	}

	const deadline = Date.now() + TIMEOUT_MIN * 60_000;
	let printed = false;

	while (Date.now() < deadline) {
		const cert = aws(["acm", "describe-certificate", "--certificate-arn", arn]).Certificate;

		if (cert.Status === "ISSUED") {
			console.log("\n✅ 証明書が発行されました");
			console.log("\ninfra/aws/params.yaml に以下を設定してください:");
			console.log(`  ApiDomainName: '${DOMAIN}'`);
			console.log(`  AcmCertificateArn: '${arn}'`);
			return;
		}
		if (cert.Status !== "PENDING_VALIDATION") {
			console.error(`\n✘ 証明書の状態が異常です: ${cert.Status}`);
			process.exit(1);
		}

		const rr = cert.DomainValidationOptions?.[0]?.ResourceRecord;
		if (rr && !printed) {
			printed = true;
			console.log("\n以下の CNAME レコードを DNS に登録してください:");
			console.log(`  名前 : ${rr.Name}`);
			console.log(`  種別 : ${rr.Type}`);
			console.log(`  値   : ${rr.Value}`);
			console.log("\n  Cloudflare DNS の場合、Proxy は必ず OFF (DNS only) にしてください。");
			console.log("\n検証完了を待っています (Ctrl+C で中断しても証明書は残ります)...");
		}
		await sleep(15_000);
		process.stdout.write(".");
	}

	console.error(`\n✘ ${TIMEOUT_MIN} 分以内に検証が完了しませんでした。`);
	console.error("  DNS レコードを確認のうえ、同じコマンドを再実行してください (証明書は再利用されます)。");
	console.error(`  ARN: ${arn}`);
	process.exit(1);
}

main();
