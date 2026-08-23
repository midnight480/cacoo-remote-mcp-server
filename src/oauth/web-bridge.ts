// oauth/web-bridge.ts
// Express の req/res と Web 標準の Request/Response を相互変換する。
//
// SDK の StreamableHTTPServerTransport (Node 版) は @hono/node-server 経由で
// 変換を行うが、serverless-http が渡す擬似 Node リクエストからはヘッダを
// 読み取れず、Accept 検証が必ず失敗する。そのため変換を自前で行い、
// WebStandardStreamableHTTPServerTransport を直接使う。

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";

/** Express のリクエストから Web 標準の Request を組み立てる */
export function toWebRequest(req: ExpressRequest, origin: string): Request {
	const url = new URL(req.originalUrl || req.url, origin);

	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v);
		} else {
			headers.set(key, value);
		}
	}

	const hasBody = req.method !== "GET" && req.method !== "HEAD";
	// express.json() が既にボディを読み切っているため、生ストリームは使えない。
	// パース済みの値を再度直列化する。
	let body: string | undefined;
	if (hasBody && req.body !== undefined && req.body !== null) {
		body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
	}

	return new Request(url, { method: req.method, headers, body });
}

/** Web 標準の Response を Express のレスポンスへ書き出す */
export async function writeWebResponse(
	res: ExpressResponse,
	webRes: Response,
): Promise<void> {
	res.status(webRes.status);
	webRes.headers.forEach((value, key) => {
		// Content-Length は実際の書き出し結果とずれる可能性があるため付け直さない
		if (key.toLowerCase() === "content-length") return;
		res.setHeader(key, value);
	});

	if (!webRes.body) {
		res.end();
		return;
	}

	// SSE の場合はストリームのまま流す。
	// pipeline は完了・失敗のどちらでも必ず settle するため、Lambda で
	// 「解決されない Promise」による Runtime.NodeJsExit を起こさない。
	// (イベントリスナを手書きすると、クライアント切断などの経路で
	//  resolve されないケースが残る)
	const nodeStream = Readable.fromWeb(webRes.body as Parameters<typeof Readable.fromWeb>[0]);
	try {
		await pipeline(nodeStream, res);
	} catch (e) {
		// クライアント側の切断は異常ではない
		const code = (e as NodeJS.ErrnoException | undefined)?.code;
		if (code !== "ERR_STREAM_PREMATURE_CLOSE" && code !== "EPIPE") {
			console.error("failed to write response body:", e);
		}
	}
}
