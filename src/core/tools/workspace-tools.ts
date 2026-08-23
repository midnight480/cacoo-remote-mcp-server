// workspace-tools.ts
// フォルダ・組織・アカウント・ライセンス・ユーザーの参照系。
//
// いずれも読み取りのみで、Cacoo 側の書き込み API が無いカテゴリ。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type CacooAccountsConfig, callCacooApi, resolveAccount } from "../cacoo-client";
import { accountParam, asText, organizationKeyParam, withErrorHandling } from "./shared";

export function registerWorkspaceTools(server: McpServer, config: CacooAccountsConfig) {
	server.tool(
		"list_accounts",
		"List the configured Cacoo accounts, which one is the default, and whether each allows writes.",
		{},
		async () => {
			const accounts = config.accounts.map((a) => ({
				name: a.name,
				baseUrl: a.baseUrl,
				organizationKey: a.organizationKey,
				isDefault: a.name === config.defaultAccount,
				readOnly: a.readOnly === true,
			}));
			return asText(accounts);
		},
	);

	server.tool(
		"list_folders",
		"List the folders in the account.",
		{ ...accountParam, ...organizationKeyParam },
		withErrorHandling(async ({ account: accountName, organizationKey }) => {
			const account = resolveAccount(config, accountName);
			return asText(
				await callCacooApi(account, {
					path: "folders.json",
					withOrganizationKey: true,
					query: { organizationKey },
				}),
			);
		}),
	);

	server.tool(
		"list_organizations",
		"List the organizations the account belongs to. The `key` field of each is the organizationKey required by diagram and folder tools.",
		{ ...accountParam },
		withErrorHandling(async ({ account: accountName }) => {
			const account = resolveAccount(config, accountName);
			return asText(await callCacooApi(account, { path: "organizations.json" }));
		}),
	);

	server.tool(
		"get_account",
		"Get the profile of the authenticated account.",
		{ ...accountParam },
		withErrorHandling(async ({ account: accountName }) => {
			const account = resolveAccount(config, accountName);
			return asText(await callCacooApi(account, { path: "account.json" }));
		}),
	);

	server.tool(
		"get_license",
		"Get the license/plan details of the authenticated account (limits and capabilities).",
		{ ...accountParam },
		withErrorHandling(async ({ account: accountName }) => {
			const account = resolveAccount(config, accountName);
			return asText(await callCacooApi(account, { path: "account/license.json" }));
		}),
	);

	server.tool(
		"get_user",
		"Get the public profile of a user by name.",
		{
			...accountParam,
			name: z.string().describe("The user name (account identifier) to look up."),
		},
		withErrorHandling(async ({ account: accountName, name }) => {
			const account = resolveAccount(config, accountName);
			return asText(
				await callCacooApi(account, { path: `users/${encodeURIComponent(name)}.json` }),
			);
		}),
	);
}
