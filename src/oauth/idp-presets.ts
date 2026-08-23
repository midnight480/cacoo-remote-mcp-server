// oauth/idp-presets.ts
// よく使う上流 IdP のエンドポイント定義。
//
// upstream.ts は任意の OIDC プロバイダを扱えるが、Google と Entra ID は
// エンドポイントが固定なので、プラットフォームごとに書き写さずここに集約する。
// どのプラットフォームからもどちらの IdP も選べる (既定値だけが違う)。

export type IdpKind = "google" | "entra";

export interface IdpEndpoints {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwksUri: string;
}

/** Google アカウント (accounts.google.com)。authorize / token / JWKS が別ホストにある。 */
export const GOOGLE_IDP: IdpEndpoints = {
	issuer: "https://accounts.google.com",
	authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
	tokenEndpoint: "https://oauth2.googleapis.com/token",
	jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
};

/**
 * Microsoft Entra ID。テナント ID ごとに URL が変わる。
 * JWKS は issuer 直下ではなく /discovery/v2.0/keys にある。
 */
export function entraIdp(tenantId: string): IdpEndpoints {
	const base = `https://login.microsoftonline.com/${tenantId}`;
	return {
		issuer: `${base}/v2.0`,
		authorizationEndpoint: `${base}/oauth2/v2.0/authorize`,
		tokenEndpoint: `${base}/oauth2/v2.0/token`,
		jwksUri: `${base}/discovery/v2.0/keys`,
	};
}

/**
 * 環境変数から上流 IdP を決める。
 *
 * UPSTREAM_IDP が未指定なら defaultKind を使う。Entra ID を選ぶ場合は
 * UPSTREAM_TENANT_ID が要る。両プラットフォームで同じ規約にしておくことで、
 * GCP でも Entra ID、Azure でも Google が選べる。
 */
export function resolveIdp(
	env: Record<string, string | undefined>,
	defaultKind: IdpKind,
): IdpEndpoints {
	const kind = (env.UPSTREAM_IDP || defaultKind) as IdpKind;
	if (kind === "google") return GOOGLE_IDP;
	if (kind === "entra") {
		const tenantId = env.UPSTREAM_TENANT_ID;
		if (!tenantId) {
			throw new Error("UPSTREAM_IDP=entra requires UPSTREAM_TENANT_ID");
		}
		return entraIdp(tenantId);
	}
	throw new Error(`Unknown UPSTREAM_IDP: ${kind}. Use "google" or "entra".`);
}
