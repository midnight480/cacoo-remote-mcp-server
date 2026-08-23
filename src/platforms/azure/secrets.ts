// platforms/azure/secrets.ts
// Key Vault から値を取得する。AWS の Secrets Manager、GCP の Secret Manager に相当。
//
// Cacoo API キーと OAuth の client secret は環境変数に置かず、シークレット名だけを
// 渡して実行時にここで解決する。認証は DefaultAzureCredential なので、
// Container Apps ではマネージド ID が、ローカルでは az login の資格情報が使われる。
//
// コンテナが生きている間はキャッシュするので取得は 1 回で済む。

import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

const clients = new Map<string, SecretClient>();
const cache = new Map<string, Promise<string>>();

function clientFor(vaultUrl: string): SecretClient {
	let client = clients.get(vaultUrl);
	if (!client) {
		client = new SecretClient(vaultUrl, new DefaultAzureCredential());
		clients.set(vaultUrl, client);
	}
	return client;
}

export function getSecret(vaultUrl: string, name: string): Promise<string> {
	const key = `${vaultUrl}#${name}`;
	let pending = cache.get(key);
	if (!pending) {
		pending = clientFor(vaultUrl)
			.getSecret(name)
			.then((res) => {
				if (!res.value) throw new Error(`Secret ${name} has no value`);
				return res.value;
			})
			.catch((e) => {
				// 失敗をキャッシュしたままにすると復旧できないので捨てる
				cache.delete(key);
				throw e;
			});
		cache.set(key, pending);
	}
	return pending;
}
