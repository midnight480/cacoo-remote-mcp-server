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

	server.tool(
		"get_inserted_image",
		"Get an image inserted into a diagram, identified by the source-id shown in the " +
			"diagram contents XML. Fails for images over 4MB.",
		{
			...accountParam,
			diagramId: z.string().describe("The diagram ID."),
			imageSourceId: z
				.string()
				.describe(
					"The source-id attribute of an <image> element returned by get_diagram_contents.",
				),
		},
		withErrorHandling(async ({ account: accountName, diagramId, imageSourceId }) => {
			const account = resolveAccount(config, accountName);
			return asImage(
				await callCacooApiBinary(account, {
					path: `diagrams/${encodeURIComponent(diagramId)}/contents/images/${encodeURIComponent(imageSourceId)}`,
				}),
			);
		}),
	);

	server.tool(
		"get_editor_token",
		"Get a token for opening the Cacoo Editor without signing in " +
			"(the 'editorToken' parameter of the Editor API).",
		{
			...accountParam,
			diagramId: z.string().describe("The diagram ID."),
		},
		withErrorHandling(async ({ account: accountName, diagramId }) => {
			const account = resolveAccount(config, accountName);
			return asText(
				await callCacooApi(account, {
					path: `diagrams/${encodeURIComponent(diagramId)}/editor/token.json`,
				}),
			);
		}),
	);

	server.tool(
		"register_editor_automation",
		"Register operations that run automatically when the Editor is opened. " +
			"Returns an 'automationToken' for the Editor API. The operations modify the diagram.",
		{
			...accountParam,
			diagramId: z.string().describe("The diagram ID."),
			operations: z
				.array(
					z.discriminatedUnion("type", [
						z.object({
							type: z.literal("AddImageUrl"),
							parameter: z.object({
								url: z.string().describe("URL of the image to insert."),
								x: z.number().int().optional().describe("X coordinate (default 0)."),
								y: z.number().int().optional().describe("Y coordinate (default 0)."),
							}),
						}),
						z.object({
							type: z.literal("DeleteObject"),
							parameter: z.object({
								uid: z
									.string()
									.describe("uid of the object to delete (from get_diagram_contents)."),
								sheetUid: z
									.string()
									.describe("uid of the sheet containing the object."),
							}),
						}),
					]),
				)
				.describe("Operations to run when the Editor opens."),
			onError: z
				.enum(["ignore", "message", "stop"])
				.optional()
				.describe(
					'Behavior when an operation fails: "ignore" continues, "message" shows an ' +
						'error in the Editor and aborts, "stop" aborts silently (default "ignore").',
				),
		},
		withErrorHandling(async ({ account: accountName, diagramId, operations, onError }) => {
			const account = resolveAccount(config, accountName);
			return asText(
				await callCacooApi(account, {
					method: "POST",
					path: `diagrams/${encodeURIComponent(diagramId)}/editor/automation.json`,
					query: {
						command: JSON.stringify({ operations, error: onError ?? "ignore" }),
					},
				}),
			);
		}),
	);

	server.tool(
		"get_oembed",
		"Get oEmbed metadata (embed HTML, thumbnail URL, dimensions) for a diagram page " +
			"URL. No API key is needed, but the diagram must be a public resource.",
		{
			...accountParam,
			url: z
				.string()
				.describe(
					"URL of the diagram detail page, e.g. https://cacoo.com/diagrams/00e77f4dc9973517",
				),
			maxwidth: z
				.number()
				.int()
				.optional()
				.describe("Maximum width of the embedding viewer (default 450)."),
			maxheight: z
				.number()
				.int()
				.optional()
				.describe("Maximum height of the embedding viewer (default 350)."),
		},
		withErrorHandling(async ({ account: accountName, url, maxwidth, maxheight }) => {
			const account = resolveAccount(config, accountName);
			// oEmbed は /api/v1 の外にあり、認証も不要
			return asText(
				await callCacooApi(account, {
					path: "oembed.json",
					outsideApi: true,
					noAuth: true,
					query: { url, maxwidth, maxheight },
				}),
			);
		}),
	);
}
