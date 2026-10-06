import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	HTML_RENDER_CONTENT_SECURITY_POLICY,
	injectHtmlRenderBootstrap,
} from "../../src/core/extensions/builtin/html-render/bootstrap.ts";
import { inlineLocalImages } from "../../src/core/extensions/builtin/html-render/images.ts";
import htmlRenderExtension from "../../src/core/extensions/builtin/html-render/index.ts";
import { showHtmlPageTool } from "../../src/core/extensions/builtin/html-render/tool.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0)]);

const ctxFor = (cwd: string): ExtensionToolContext =>
	({
		cwd,
		hasUI: false,
		ui: undefined,
		tools: [],
		executeTool: () => Promise.reject(new Error("not used")),
	}) as unknown as ExtensionToolContext;

describe("html-render builtin", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-html-render-"));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("registers show_html_page", async () => {
		const harness = await createHarness({ extensionFactories: [htmlRenderExtension] });
		try {
			const names = harness.agent.state.tools.map((tool) => tool.name);
			expect(names).toContain("show_html_page");
		} finally {
			harness.cleanup();
		}
	});

	it("writes a prepared page with the theme bootstrap injected ahead of the head content", async () => {
		const result = await showHtmlPageTool.execute(
			"call-1",
			{
				html: "<!doctype html><html><head><title>t</title></head><body>hi</body></html>",
				title: "Revenue",
				height: 260,
			},
			undefined,
			undefined,
			ctxFor(tempDir),
		);
		const path = (result.details as { path: string }).path;
		const written = readFileSync(path, "utf8");
		expect(written).toContain('id="t3-theme"');
		expect(written.indexOf('id="t3-theme"')).toBeLessThan(written.indexOf("<title>"));
		expect((result.details as { prepared: boolean }).prepared).toBe(true);
		expect(path).toContain(".senpi/html-pages");
	});

	it("opens the written page with the offline snapshot policy ahead of anything the page wrote", async () => {
		const result = await showHtmlPageTool.execute(
			"call-3",
			{
				html: '<!doctype html><script src="https://cdn.example/lib.js"></script><img src="http://127.0.0.1:1/x.png">',
				title: "Offline",
			},
			undefined,
			undefined,
			ctxFor(tempDir),
		);
		const written = readFileSync((result.details as { path: string }).path, "utf8");
		const policy = `<meta http-equiv="Content-Security-Policy" content="${HTML_RENDER_CONTENT_SECURITY_POLICY}">`;
		expect(written.startsWith(`<!doctype html>${policy}`)).toBe(true);
		expect(written.indexOf(policy)).toBeLessThan(written.indexOf("cdn.example"));
	});

	it("clamps the frame height to the 80-2000 range", async () => {
		const result = await showHtmlPageTool.execute(
			"call-2",
			{ html: "<p>x</p>", title: "Tall", height: 99999 },
			undefined,
			undefined,
			ctxFor(tempDir),
		);
		expect((result.details as { height: number }).height).toBe(2000);
	});

	it("inlines an absolute-path local image as a data URI", async () => {
		const imagePath = join(tempDir, "chart.png");
		writeFileSync(imagePath, PNG_BYTES);
		const { html, missing } = await inlineLocalImages(`<img src="${imagePath}">`);
		expect(html).toContain("data:image/png;base64,");
		expect(missing).toHaveLength(0);
	});

	it("refuses a renamed secret written to an image path", async () => {
		const secretPath = join(tempDir, "secret.png");
		writeFileSync(secretPath, "API_KEY=hunter2 not an image");
		const { html, missing } = await inlineLocalImages(`<img src="${secretPath}">`);
		expect(html).not.toContain("data:");
		expect(missing).toContain(secretPath);
	});

	it("refuses a page that grows past the page size cap when images inline", async () => {
		const bigPath = join(tempDir, "big.png");
		const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		writeFileSync(bigPath, Buffer.concat([head, Buffer.alloc(11 * 1024 * 1024, 1)]));
		await expect(inlineLocalImages(`<img src="${bigPath}">`)).rejects.toThrow(/at most 10 MiB/);
	});

	it("injects the bootstrap into a bare fragment", () => {
		const prepared = injectHtmlRenderBootstrap("<div>chart</div>");
		expect(prepared).toContain('id="t3-theme"');
		expect(prepared).toContain("<div>chart</div>");
	});
});
