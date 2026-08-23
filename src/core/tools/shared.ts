// tools/shared.ts
// ツール実装で共通に使う小物。

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type CacooBinary, formatCacooError } from "../cacoo-client";

/** どのツールでも「どのアカウントに対して実行するか」を選べるようにする */
export const accountParam = {
	account: z
		.string()
		.optional()
		.describe("Account name to query. Uses the default account if omitted."),
};

/**
 * diagrams / folders 系で必要になる organizationKey。
 * レガシープラン以外では必須で、アカウント設定の既定値があればそちらが使われる。
 */
export const organizationKeyParam = {
	organizationKey: z
		.string()
		.optional()
		.describe(
			"Organization key. Required on non-legacy plans. Falls back to the account's " +
				"configured default. Use list_organizations to discover it.",
		),
};

export const asText = (result: unknown): CallToolResult => ({
	content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
});

export const asPlainText = (text: string): CallToolResult => ({
	content: [{ type: "text" as const, text }],
});

export const asImage = (binary: CacooBinary): CallToolResult => ({
	content: [
		{ type: "image" as const, data: binary.base64, mimeType: binary.mimeType },
		{
			type: "text" as const,
			text: JSON.stringify({ mimeType: binary.mimeType, size: binary.size }, null, 2),
		},
	],
});

/**
 * 例外をツール結果に変換する。サーバを落とさず、呼び出し側が読める形で返す。
 * readOnly ガードや Cacoo のエラー応答もここで文字列になる。
 */
export function withErrorHandling<Args>(
	handler: (input: Args) => Promise<CallToolResult>,
): (input: Args) => Promise<CallToolResult> {
	return async (input: Args) => {
		try {
			return await handler(input);
		} catch (err) {
			return {
				content: [{ type: "text", text: formatCacooError(err) }],
				isError: true,
			};
		}
	};
}
