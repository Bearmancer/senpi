import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool, type ExtensionToolContext } from "../../types.ts";
import { injectHtmlRenderBootstrap } from "./bootstrap.ts";
import { inlineLocalImages } from "./images.ts";

const Params = Type.Object({
	html: Type.String({ description: "A complete, self-contained HTML document.", minLength: 1 }),
	title: Type.String({ description: "Short name for the page.", minLength: 1, maxLength: 200 }),
	height: Type.Optional(
		Type.Integer({
			description: "Frame height hint in CSS pixels, 80-2000. Defaults to the page's natural height.",
		}),
	),
});

const OUTPUT_DIR = ".senpi/html-pages";

export interface ShowHtmlPageDetails {
	path: string;
	title: string;
	height: number | undefined;
	prepared: boolean;
	missingImages?: string[];
}

const clampHeight = (height: number | undefined) =>
	height === undefined ? undefined : Math.min(2000, Math.max(80, Math.round(height)));

export const showHtmlPageTool = defineTool<typeof Params, ShowHtmlPageDetails>({
	name: "show_html_page",
	label: "Show HTML Page",
	description:
		"Show a finished self-contained HTML page (chart, table, diagram, mockup) to the reader. " +
		"Load the bundled visualize skill first for the design system and the data pipeline. " +
		"The page is one self-contained document with inline <style> and <script> (the viewer sandbox blocks " +
		"network access, so no CDN libraries or remote assets). Local images written as absolute file paths " +
		"are inlined automatically after a byte check. In the desktop thread this renders inline above your " +
		"reply; elsewhere it is written to a file you can open in the desktop. Preview with preview_html_page first.",
	promptSnippet: "show_html_page: show a self-contained HTML page (chart/table/diagram) to the reader",
	promptGuidelines: [
		"Load the bundled visualize skill before building an HTML page; it carries the design system and routes data through the data-scientist skill.",
		"Write one self-contained document with inline CSS and JS; the sandbox blocks network access.",
		"Absolute-path local images are inlined after a magic-byte check; a renamed non-image is refused.",
	],
	parameters: Params,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
		const inlined = await inlineLocalImages(params.html);
		const prepared = injectHtmlRenderBootstrap(inlined.html);
		const height = clampHeight(params.height);
		const dir = join(ctx.cwd, OUTPUT_DIR);
		await mkdir(dir, { recursive: true });
		const safeName =
			params.title
				.replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 60) || "page";
		const path = join(dir, `${safeName}-${Date.now().toString(36)}.html`);
		await writeFile(path, prepared, "utf8");
		const missing = inlined.missing.length === 0 ? undefined : inlined.missing;
		return {
			content: [
				{
					type: "text",
					text:
						`Wrote the page to ${path}. Open it in the desktop to see it rendered with your theme. ` +
						(missing === undefined
							? "Local images were inlined."
							: `Some local images could not be read and were left as written: ${missing.join(", ")}.`),
				},
			],
			details: { path, title: params.title, height, prepared: true, ...(missing ? { missingImages: missing } : {}) },
		};
	},
});
