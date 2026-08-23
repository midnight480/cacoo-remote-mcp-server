// diagram-tools.ts
// 図の一覧・取得・作成・複製・移動・削除・描画・内容取得。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	type CacooAccountsConfig,
	callCacooApi,
	callCacooApiBinary,
	callCacooApiText,
	resolveAccount,
} from "../cacoo-client";
import {
	accountParam,
	asImage,
	asPlainText,
	asText,
	organizationKeyParam,
	withErrorHandling,
} from "./shared";

export function registerDiagramTools(server: McpServer, config: CacooAccountsConfig) {
	server.tool(
		"list_diagrams",
		"List diagrams in the account, with optional filtering, sorting and pagination.",
		{
			...accountParam,
			...organizationKeyParam,
			offset: z.number().int().optional().describe("Starting position of the result set (default 0)."),
			limit: z.number().int().optional().describe("Number of diagrams to return (default 50)."),
			type: z
				.enum(["all", "own", "shared", "stencil", "template", "recyclebin"])
				.optional()
				.describe('Filter diagrams by type (default "all").'),
			sortOn: z
				.enum(["updated", "title", "owner", "folder"])
				.optional()
				.describe('Field to sort on (default "updated").'),
			sortType: z.enum(["desc", "asc"]).optional().describe('Sort direction (default "desc").'),
			folderId: z.number().int().optional().describe("Restrict results to a single folder."),
			keyword: z.string().optional().describe("Search keyword."),
		},
		withErrorHandling(async ({ account: accountName, ...query }) => {
			const account = resolveAccount(config, accountName);
			return asText(
				await callCacooApi(account, {
					path: "diagrams.json",
					withOrganizationKey: true,
					query,
				}),
			);
		}),
	);

	server.tool(
		"get_diagram",
		"Get the details of a single diagram, including its sheets and comments.",
		{
			...accountParam,
			diagramId: z.string().describe("The diagram ID."),
		},
		withErrorHandling(async ({ account: accountName, diagramId }) => {
			const account = resolveAccount(config, accountName);
			return asText(
				await callCacooApi(account, {
					path: `diagrams/${encodeURIComponent(diagramId)}.json`,
				}),
			);
		}),
	);

	server.tool(
		"create_diagram",
		"Create a new (empty) diagram.",
		{
			...accountParam,
			...organizationKeyParam,
			title: z.string().optional().describe('Diagram title (default "Untitled").'),
			description: z.string().optional().describe("Diagram description."),
			folderId: z.number().int().optional().describe("Folder to create the diagram in."),
			security: z
				.enum(["private", "url", "public"])
				.optional()
				.describe("Sharing setting of the new diagram."),
		},
		withErrorHandling(async ({ account: accountName, ...query }) => {
			const account = resolveAccount(config, accountName);
			return asText(
				await callCacooApi(account, {
					method: "POST",
					path: "diagrams/create.json",
					withOrganizationKey: true,
					query,
				}),
			);
		}),
	);

	server.tool(
		"copy_diagram",
		"Create a copy of an existing diagram.",
		{
			...accountParam,
			...organizationKeyParam,
			diagramId: z.string().describe("The source diagram ID to copy."),
			title: z.string().optional().describe('Title of the copy (default "Untitled").'),
			description: z.string().optional().describe("Description of the copy."),
			folderId: z.number().int().optional().describe("Folder to place the copy in."),
			security: z
				.enum(["private", "url", "public"])
				.optional()
				.describe("Sharing setting of the copy."),
		},
		withErrorHandling(async ({ account: accountName, diagramId, ...query }) => {
			const account = resolveAccount(config, accountName);
			return asText(
				await callCacooApi(account, {
					method: "POST",
					path: `diagrams/${encodeURIComponent(diagramId)}/copy.json`,
					withOrganizationKey: true,
					query,
				}),
			);
		}),
	);

	server.tool(
		"move_diagram",
		"Move a diagram to a different folder.",
		{
			...accountParam,
			...organizationKeyParam,
			diagramId: z.string().describe("The diagram ID to move."),
			folderId: z.number().int().describe("Destination folder ID."),
		},
		withErrorHandling(async ({ account: accountName, diagramId, ...query }) => {
			const account = resolveAccount(config, accountName);
			return asText(
				await callCacooApi(account, {
					method: "POST",
					path: `diagrams/${encodeURIComponent(diagramId)}/move.json`,
					withOrganizationKey: true,
					query,
				}),
			);
		}),
	);

	server.tool(
		"delete_diagram",
		"Delete a diagram. Fails if the caller is not the owner or the diagram is being edited.",
		{
			...accountParam,
			...organizationKeyParam,
			diagramId: z.string().describe("The diagram ID to delete."),
		},
		withErrorHandling(async ({ account: accountName, diagramId, organizationKey }) => {
			const account = resolveAccount(config, accountName);
			await callCacooApi(account, {
				method: "POST",
				path: `diagrams/${encodeURIComponent(diagramId)}/delete.json`,
				withOrganizationKey: true,
				query: { organizationKey },
			});
			return asPlainText(`Diagram ${diagramId} deleted.`);
		}),
	);

	server.tool(
		"get_diagram_image",
		"Get a PNG rendering of a diagram (or a single sheet of it). Fails for images over 4MB.",
		{
			...accountParam,
			diagramId: z.string().describe("The diagram ID."),
			sheetId: z.string().optional().describe("Optional sheet ID to render a specific sheet."),
			width: z.number().int().optional().describe("Image width in pixels."),
			height: z.number().int().optional().describe("Image height in pixels."),
		},
		withErrorHandling(async ({ account: accountName, diagramId, sheetId, width, height }) => {
			const account = resolveAccount(config, accountName);
			// シートを指定する場合は <diagramId>-<sheetId> という 1 つの ID になる
			const id = sheetId
				? `${encodeURIComponent(diagramId)}-${encodeURIComponent(sheetId)}`
				: encodeURIComponent(diagramId);
			return asImage(
				await callCacooApiBinary(account, {
					path: `diagrams/${id}.png`,
					query: { width, height },
				}),
			);
		}),
	);

	server.tool(
		"get_diagram_contents",
		"Get the structured contents of a diagram (shapes, text, lines, images) as XML.",
		{
			...accountParam,
			diagramId: z.string().describe("The diagram ID."),
			returnValues: z
				.string()
				.optional()
				.describe(
					"Comma-separated subset of detail to include: textStyle, shapeStyle, uid, position, point.",
				),
		},
		withErrorHandling(async ({ account: accountName, diagramId, returnValues }) => {
			const account = resolveAccount(config, accountName);
			return asPlainText(
				await callCacooApiText(account, {
					path: `diagrams/${encodeURIComponent(diagramId)}/contents.xml`,
					query: { returnValues },
				}),
			);
		}),
	);
}
