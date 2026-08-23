// oauth/serve.ts
// コンテナで動く Node 実行環境 (Cloud Run / Container Apps) 向けの起動処理。
//
// Lambda は serverless-http でイベントを受けるが、コンテナ側は普通に listen する。
// その差だけを吸収する薄い層で、両プラットフォームで同じものを使う。

import type { Express } from "express";

/** Cloud Run も Container Apps も PORT 環境変数で待ち受けポートを指示してくる。 */
export function portFrom(env: Record<string, string | undefined>, fallback = 8080): number {
	const raw = env.PORT;
	if (!raw) return fallback;
	const port = Number.parseInt(raw, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid PORT: ${raw}`);
	}
	return port;
}

/**
 * Express アプリを起動し、SIGTERM で綺麗に落とす。
 * Cloud Run も Container Apps も停止時に SIGTERM を送るため、
 * 受け取らないと処理中のリクエストが切られる。
 */
export function serve(app: Express, port: number, onListen?: () => void): void {
	const server = app.listen(port, () => {
		console.log(`listening on :${port}`);
		onListen?.();
	});

	const shutdown = (signal: string) => {
		console.log(`${signal} received, shutting down`);
		server.close((err) => {
			if (err) {
				console.error("shutdown failed:", err);
				process.exit(1);
			}
			process.exit(0);
		});
		// 猶予を過ぎたら強制終了する。閉じない接続で停止が詰まるのを避ける。
		setTimeout(() => process.exit(0), 10_000).unref();
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}
