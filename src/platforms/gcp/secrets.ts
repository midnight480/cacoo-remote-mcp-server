// platforms/gcp/secrets.ts
// Secret Manager から値を取得する。AWS 版の secrets.ts に相当。
//
// Cacoo API キーと OAuth の client secret は環境変数に置かず、
// シークレット名だけを渡して実行時にここで解決する。
// コンテナが生きている間はキャッシュするので取得は 1 回で済む。

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const client = new SecretManagerServiceClient();
const cache = new Map<string, Promise<string>>();

/**
 * @param name `projects/<project>/secrets/<name>/versions/latest` 形式、
 *             または `<name>` だけ渡して projectId から組み立てる。
 */
export function getSecret(name: string, projectId?: string): Promise<string> {
	const full = name.startsWith("projects/")
		? name
		: `projects/${projectId}/secrets/${name}/versions/latest`;

	let pending = cache.get(full);
	if (!pending) {
		pending = client
			.accessSecretVersion({ name: full })
			.then(([res]) => {
				const data = res.payload?.data;
				if (!data) throw new Error(`Secret ${full} has no payload`);
				return Buffer.from(data as Uint8Array).toString("utf8");
			})
			.catch((e) => {
				// 失敗をキャッシュしたままにすると復旧できないので捨てる
				cache.delete(full);
				throw e;
			});
		cache.set(full, pending);
	}
	return pending;
}
