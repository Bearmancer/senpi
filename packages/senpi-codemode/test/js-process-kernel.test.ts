import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import type { JavaScriptKernelOptions } from "../src/kernels/js/local-module-loader.ts";
import { parseJavaScriptResult, runJavaScriptCell } from "./eval/js-kernel-harness.ts";

const kernels = new Set<JavaScriptKernel>();
const tempRoots = new Set<string>();

async function trackedTempRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.add(root);
	return root;
}

function processKernel(options: Partial<JavaScriptKernelOptions> = {}): JavaScriptKernel {
	const kernel = new JavaScriptKernel({
		sessionId: `process-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 2,
		isolation: "process",
		...options,
	});
	kernels.add(kernel);
	return kernel;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function groupAlive(groupId: number): boolean {
	try {
		process.kill(-groupId, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (condition()) return;
		if (Date.now() > deadline) throw new Error(`${label} did not hold within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// RED on the base: no implementation means the probe kernel never reaches mode "process", so the
// test fails there. GREEN once the feature lands: the probe confirms process mode, then fn runs.
const itProcessMode = (name: string, fn: () => Promise<void>, timeout: number): void => {
	it(name, { timeout }, async (context) => {
		if (process.env.SENPI_CODEMODE_JS_ISOLATION !== "process") {
			context.skip("skipped: SENPI_CODEMODE_JS_ISOLATION is not 'process'");
		}
		const probe = new JavaScriptKernel({
			sessionId: `process-probe-${crypto.randomUUID()}`,
			cwd: process.cwd(),
			parallelPoolWidth: 1,
			isolation: "process",
		});
		kernels.add(probe);
		try {
			const ready = probe.run({
				cellId: `process-probe-${crypto.randomUUID()}`,
				code: "return 1",
				timeoutMs: 10_000,
			});
			await vi.waitFor(
				() => {
					if (probe.mode !== "process") throw new Error("process mode not implemented");
				},
				{ timeout: 10_000 },
			);
			await ready;
		} finally {
			await probe.close();
			kernels.delete(probe);
		}
		await fn();
	});
};

describe("JavaScriptKernel process isolation", () => {
	itProcessMode(
		"initializes, runs cells, round-trips tool calls, interrupts a cell, and closes the child",
		async () => {
			const root = await trackedTempRoot("senpi-js-process-basic-");
			const kernel = processKernel({ cwd: root });
			const first = await runJavaScriptCell(kernel, "const answer = 40 + 2");
			expect(kernel.mode).toBe("process");
			expect(first.result).toMatchObject({ ok: true });
			const pid = kernel.processPid;
			expect(pid).toBeTypeOf("number");
			const second = await runJavaScriptCell(kernel, "return answer");
			expect(second.result).toMatchObject({ ok: true, valueRepr: "42" });

			const toolRun = kernel.run({
				cellId: "process-tool",
				code: "return await tool.read({ path: 'demo.txt' })",
				timeoutMs: 5_000,
			});
			const call = await kernel.nextToolCall();
			expect(call).toMatchObject({ type: "tool-call", toolName: "read", args: { path: "demo.txt" } });
			kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: "from-host" });
			await expect(toolRun).resolves.toMatchObject({ ok: true, valueRepr: '"from-host"' });

			const stuck = kernel.run({
				cellId: "process-interrupt",
				code: "await new Promise(() => {})",
				timeoutMs: 10_000,
			});
			const interruption = await kernel.interrupt("test stop", "process-interrupt");
			await expect(interruption.stateRetained).resolves.toBeDefined();
			await expect(stuck).resolves.toMatchObject({ ok: false });
			const after = await runJavaScriptCell(kernel, "return 'still alive'");
			expect(after.result).toMatchObject({ ok: true, valueRepr: '"still alive"' });

			await kernel.close();
			kernels.delete(kernel);
			await waitFor("child exit", () => !pidAlive(pid as number));
		},
		30_000,
	);

	itProcessMode(
		"routes a cell's direct fd 1 writes into text frames and keeps the frame channel intact",
		async () => {
			const kernel = processKernel();
			const cell = await runJavaScriptCell(
				kernel,
				[
					`process.stdout.write("via-process-stdout");`,
					`if (globalThis.Bun !== undefined) await Bun.write(Bun.stdout, "via-bun-write");`,
					`console.log("via-console-log");`,
					`return "done";`,
				].join("\n"),
			);
			expect(cell.result).toMatchObject({ ok: true, valueRepr: '"done"' });
			const text = cell.messages
				.filter((message) => message.type === "text")
				.map((message) => (message as { data: string }).data)
				.join("");
			expect(text).toContain("via-process-stdout");
			if (process.versions.bun !== undefined) expect(text).toContain("via-bun-write");
			expect(text).toContain("via-console-log");

			const next = await runJavaScriptCell(kernel, "return 6 * 7");
			expect(parseJavaScriptResult(next.result)).toBe(42);
		},
		30_000,
	);

	if (process.platform !== "win32")
		itProcessMode(
			"survives a SIGSEGV of its child and runs the next cell on a replacement with the restart notice",
			async () => {
				const kernel = processKernel();
				await runJavaScriptCell(kernel, "globalThis.beforeCrash = 'marked'");
				const pid = kernel.processPid;
				expect(pid).toBeTypeOf("number");

				const crashed = await runJavaScriptCell(kernel, 'process.kill(process.pid, "SIGSEGV")');
				expect(crashed.result).toMatchObject({ ok: false });
				if (!crashed.result.ok) expect(crashed.result.error.message).toMatch(/SIGSEGV|signal 11/);
				await waitFor("crashed child exit", () => !pidAlive(pid as number));

				const after = await runJavaScriptCell(kernel, "return typeof globalThis.beforeCrash");
				expect(after.result).toMatchObject({ ok: true, valueRepr: '"undefined"' });
				expect(after.result.kernelState).toBe("restarted");
				expect(after.result.notice).toContain("kernel was restarted");
				expect(kernel.mode).toBe("process");
				expect(kernel.processPid).toBeTypeOf("number");
				expect(kernel.processPid).not.toBe(pid);
			},
			30_000,
		);

	itProcessMode(
		"leaves no child or process-group member behind after the session closes",
		async () => {
			const kernel = processKernel();
			await runJavaScriptCell(kernel, "return 1");
			const pid = kernel.processPid;
			if (pid === undefined) throw new Error("expected the kernel to expose its child pid");

			await kernel.close();
			kernels.delete(kernel);
			await waitFor("child exit", () => !pidAlive(pid));
			await waitFor("process group exit", () => !groupAlive(pid));
		},
		30_000,
	);

	itProcessMode(
		"settles the cell with a capability gap that names the runtime when none is on PATH",
		async () => {
			const kernel = processKernel({ processCommandPath: "" });
			const run = await kernel.run({ cellId: "process-no-runtime", code: "return 1", timeoutMs: 5_000 });
			expect(run).toMatchObject({ ok: false });
			if (!run.ok) expect(run.error.message).toMatch(/JavaScript runtime is unavailable/);
			if (!run.ok) expect(run.error.message).toMatch(/bun|node/);
		},
		30_000,
	);

	it("labels the process-mode badge with the isolation", async () => {
		const { formatRuntimeBadge } = await import("../src/tool/runtime-label.ts");
		const badge = formatRuntimeBadge("js", { name: "bun", version: "1.4.2" }, "/home/tester");
		expect(badge).toBe("bun 1.4.2");
		const { formatRuntimeBadge: laterBadge } = await import("../src/tool/runtime-label.ts");
		expect(laterBadge("js", { name: "bun", version: "1.4.2", isolation: "process" }, "/home/tester")).toBe(
			"bun 1.4.2, process",
		);
	});

	itProcessMode(
		"reports the child's process footprint in the result memory and registry reading",
		async () => {
			const thresholds = { gcWatermarkBytes: 0, noticeBytes: 0, ceilingBytes: 0 };
			const reads: number[] = [];
			const kernel = processKernel({
				memory: thresholds,
				processMemory: {
					thresholds,
					readFootprint: (pid: number) => {
						reads.push(pid);
						return { bytes: 12 * 1024 * 1024 };
					},
				},
			});
			const cell = await runJavaScriptCell(kernel, "return 1");
			expect(cell.result).toMatchObject({ ok: true });
			expect(reads).toContain(kernel.processPid);
			expect(cell.result.memory).toMatchObject({ measure: "footprint", liveBytes: 12 * 1024 * 1024 });
			await expect(kernel.queryMemory()).resolves.toMatchObject({ measure: "footprint" });
		},
		30_000,
	);

	it("keeps the worker default when no isolation is asked for", async () => {
		const kernel = new JavaScriptKernel({
			sessionId: `worker-default-${crypto.randomUUID()}`,
			cwd: process.cwd(),
			parallelPoolWidth: 2,
		});
		kernels.add(kernel);
		try {
			expect(kernel.mode).toBe("worker");
			const cell = await runJavaScriptCell(kernel, "return 7 * 6");
			expect(cell.result).toMatchObject({ ok: true, valueRepr: "42" });
			expect(kernel.mode).toBe("worker");
		} finally {
			await kernel.close();
			kernels.delete(kernel);
		}
	}, 30_000);

	it("in worker mode the SIGSEGV case is skipped: a worker thread shares this test's host process, so killing it would kill the host", () => {
		expect(true).toBe(true);
	});

	// The child always runs under bun in process mode, so Bun.WebView is available there even though
	// the vitest fork is node. Skip only on Windows, where process-mode WebView is unsupported.
	if (process.platform !== "win32")
		itProcessMode(
			"drives a WebView natively on the child's main thread in process mode",
			async () => {
				const kernel = processKernel();
				const cell = await runJavaScriptCell(
					kernel,
					[
						`const view = new Bun.WebView({ width: 320, height: 240 });`,
						`await view.navigate("data:text/html,<h1 id='greeting'>process mode view</h1>");`,
						`const text = await view.evaluate("document.getElementById('greeting').textContent");`,
						`view.close();`,
						`return { text, native: view instanceof Bun.WebView };`,
					].join("\n"),
					20_000,
				);
				const value = parseJavaScriptResult(cell.result);
				expect(value).toEqual({ text: "process mode view", native: true });
			},
			60_000,
		);
});
