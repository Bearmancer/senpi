import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseJavaScriptResult, runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";
import {
	bunChromeChildren,
	bunWebViewAvailable,
	serveFixturePage,
	type WebViewFixturePage,
} from "./eval/webview-fixtures.ts";

const CELL_TIMEOUT_MS = 60_000;

let page: WebViewFixturePage | undefined;

function fixtureUrl(): string {
	if (!page) throw new Error("fixture page is not running");
	return page.url;
}

describe.skipIf(!bunWebViewAvailable)("Bun.WebView from an eval cell", () => {
	beforeAll(async () => {
		page = await serveFixturePage();
	});

	afterAll(async () => {
		await page?.stop();
	});

	it("drives a chrome-backed view: navigate, evaluate, click, screenshot", async () => {
		const value = await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				[
					`const view = new Bun.WebView({ backend: "chrome", width: 640, height: 480 });`,
					`await view.navigate(${JSON.stringify(fixtureUrl())});`,
					`const greeting = await view.evaluate("document.getElementById('greeting').textContent");`,
					`await view.click("#go");`,
					`const title = await view.evaluate("document.title");`,
					`const shot = await view.screenshot();`,
					`const bytes = new Uint8Array(await shot.arrayBuffer());`,
					`const result = { greeting, title, url: view.url, isBlob: shot instanceof Blob, type: shot.type, png: bytes[0] === 0x89 && bytes[1] === 0x50, size: bytes.length };`,
					`view.close();`,
					`return result;`,
				].join("\n"),
				CELL_TIMEOUT_MS,
			);
			return parseJavaScriptResult(run.result);
		});
		expect(value).toMatchObject({
			greeting: "hello from the fixture",
			title: "clicked",
			url: fixtureUrl(),
			isBlob: true,
			type: "image/png",
			png: true,
		});
		expect(await bunChromeChildren()).toEqual([]);
	});

	it("serves the default backend: native WebKit in the worker on macOS, the main-thread Chrome elsewhere", async () => {
		const value = await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				[
					`await using view = new Bun.WebView({ width: 320, height: 240 });`,
					`await view.navigate(${JSON.stringify(fixtureUrl())});`,
					`const greeting = await view.evaluate("document.getElementById('greeting').textContent");`,
					`return { greeting, proxied: Object.getPrototypeOf(view) === Bun.WebView.prototype, isWebView: view instanceof Bun.WebView };`,
				].join("\n"),
				CELL_TIMEOUT_MS,
			);
			return parseJavaScriptResult(run.result);
		});
		expect(value).toEqual({
			greeting: "hello from the fixture",
			proxied: process.platform !== "darwin",
			isWebView: true,
		});
		expect(await bunChromeChildren()).toEqual([]);
	});

	it('proxies the WebView named by `import { WebView } from "bun"`, with console capture and raw CDP', async () => {
		const value = await withJavaScriptKernel(async (kernel) => {
			const run = await runJavaScriptCell(
				kernel,
				[
					`import { WebView } from "bun";`,
					`const logged = [];`,
					`const view = new WebView({ backend: "chrome", console: (type, ...args) => logged.push([type, ...args]) });`,
					`await view.navigate(${JSON.stringify(fixtureUrl())});`,
					`await view.evaluate("console.log('from the page', 7)");`,
					`const cdp = await view.cdp("Runtime.evaluate", { expression: "6 * 7", returnByValue: true });`,
					`view.close();`,
					`return { logged, answer: cdp.result.value };`,
				].join("\n"),
				CELL_TIMEOUT_MS,
			);
			return parseJavaScriptResult(run.result);
		});
		expect(value).toEqual({ logged: [["log", "from the page", 7]], answer: 42 });
		expect(await bunChromeChildren()).toEqual([]);
	});
});
