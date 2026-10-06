import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { EvalNotifier } from "../src/extension/eval-notifier.ts";
import type { EvalDetachedCellSnapshot } from "../src/tool/detached-cell-manager.ts";
import { buildDetachedCellNotification } from "../src/tool/detached-cell-notification.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function spillPath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-notify-budget-"));
	roots.push(root);
	return join(root, "local", "detached-eval-cell.log");
}

function completedSnapshot(
	text: string,
	images: readonly { readonly data: string; readonly mimeType: string }[] = [],
): EvalDetachedCellSnapshot {
	return {
		cellId: "budget-cell",
		language: "js",
		startedAtMs: 0,
		state: "completed",
		outputTail: "",
		stateRetained: undefined,
		result: {
			content: [{ type: "text", text }, ...images.map((image) => ({ type: "image" as const, ...image }))],
			details: { language: "js", durationMs: 0, toolCalls: [], truncated: false },
		},
	};
}

function fakeModel(): Model<Api> {
	return {
		id: "test",
		name: "test",
		api: "fake-api",
		provider: "fake",
		baseUrl: "https://fake.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

function numberedLines(count: number): string {
	return Array.from(
		{ length: count },
		(_, index) => `line ${String(index + 1).padStart(5, "0")} ${"x".repeat(60)}`,
	).join("\n");
}

describe("detached cell notification budget", () => {
	it("Given a detached cell whose output is a few kilobytes when it completes then the notification carries all of it", async () => {
		const output = numberedLines(80);
		expect(Buffer.byteLength(output)).toBeGreaterThan(4_000);

		const notification = await buildDetachedCellNotification(completedSnapshot(output), await spillPath());

		expect(notification.content).toContain(output);
		expect(notification.content).not.toMatch(/capped|elided|overflowed/u);
	});

	it("Given a detached cell whose output exceeds the budget when it completes then the notification keeps the head and the tail and says how much was elided", async () => {
		const output = numberedLines(4_000);
		const path = await spillPath();

		const notification = await buildDetachedCellNotification(completedSnapshot(output), path);

		expect(notification.content).toContain("line 00001 ");
		expect(notification.content).toContain("line 04000 ");
		expect(notification.content).toMatch(/\[… \d+ lines \(\d+ bytes\) elided; full output: .+ …\]/u);
		expect(notification.content).toContain(path);
		expect(await readFile(path, "utf8")).toContain(output);
	});

	it("Given an over-budget notification when it is built then the outcome line and the kernel-state note survive", async () => {
		const notification = await buildDetachedCellNotification(
			completedSnapshot(numberedLines(4_000)),
			await spillPath(),
		);

		expect(notification.content.startsWith("<system-reminder>Detached eval cell budget-cell (js) completed.")).toBe(
			true,
		);
		expect(notification.content).toMatch(
			/Kernel state updated - variables are available to the next eval cell\.<\/system-reminder>/u,
		);
	});

	it("Given a detached cell that displayed an image when it completes then the notification delivers the image", async () => {
		const sent: unknown[] = [];
		const notifier = new EvalNotifier({
			sendMessage: (message) => sent.push(message.content),
			getContext: () => ({ ...fakeExtensionContext(), mode: "tui" as const, model: fakeModel() }),
			getMode: () => "wake",
		});
		const notification = await buildDetachedCellNotification(
			completedSnapshot("drew a chart", [{ data: "iVBORw0KGgo=", mimeType: "image/png" }]),
			await spillPath(),
		);

		notifier.notify([notification]);

		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual([
			{ type: "text", text: expect.stringContaining("drew a chart") },
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		]);
	});
});
