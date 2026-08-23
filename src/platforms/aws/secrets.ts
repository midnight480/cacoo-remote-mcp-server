// platforms/aws/secrets.ts
// Secrets Manager から値を取得する。
//
// Lambda の環境変数は lambda:GetFunctionConfiguration 権限があれば読めるため、
// Cacoo API キーと Cognito の client secret は環境変数に置かず ARN だけを渡し、
// 実行時にここで解決する。
//
// 実行環境が再利用される間はキャッシュするので、Secrets Manager への呼び出しは
// コンテナごとに 1 回で済む。

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});
const cache = new Map<string, Promise<string>>();

export function getSecret(secretId: string): Promise<string> {
	let pending = cache.get(secretId);
	if (!pending) {
		pending = client
			.send(new GetSecretValueCommand({ SecretId: secretId }))
			.then((res) => {
				if (!res.SecretString) {
					throw new Error(`Secret ${secretId} has no SecretString`);
				}
				return res.SecretString;
			})
			.catch((e) => {
				// 失敗をキャッシュしたままにすると復旧できないので捨てる
				cache.delete(secretId);
				throw e;
			});
		cache.set(secretId, pending);
	}
	return pending;
}
