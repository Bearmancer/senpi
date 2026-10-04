import { execFileSync, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import type { JavaScriptKernelOptions } from "../src/kernels/js/local-module-loader.ts";
import { resolveJavaScriptProcessCommand, runtimeNameOf } from "../src/kernels/js/process-worker.ts";
import { parseJavaScriptResult, runJavaScriptCell } from "./eval/js-kernel-harness.ts";

const kernels = new Set<JavaScriptKernel>();
const tempRoots = new Set<string>();

async function trackedTempRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.add(root);
	return root;
}

/** A bun executable to run the kernel child under, when bun is installed: only bun can move fd 0 and fd 1. */
const bunChild = (() => {
	try {
		const command = resolveJavaScriptProcessCommand(undefined, process.platform, "bun", "");
		return runtimeNameOf(command) === "bun" ? command : undefined;
	} catch {
		return undefined;
	}
})();

const hostFixture = join(import.meta.dirname, "fixtures", "process-kernel-host.ts");

function workerKernel(): JavaScriptKernel {
	const kernel = new JavaScriptKernel({
		sessionId: `worker-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 2,
	});
	kernels.add(kernel);
	return kernel;
}

/**
 * The product runs process-mode kernels under bun, so every process-mode test does too: this suite's own host is node,
 * and a child that followed the host's runtime would test node only.
 */
function productChild(): string {
	if (bunChild === undefined)
		throw new Error("process-mode tests need bun on PATH: the product's kernel child runs on bun");
	return bunChild;
}

function processKernel(options: Partial<JavaScriptKernelOptions> = {}): JavaScriptKernel {
	const kernel = new JavaScriptKernel({
		sessionId: `process-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 2,
		isolation: "process",
		processExecPath: productChild(),
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
	it(name, { timeout }, async () => {
		const probe = new JavaScriptKernel({
			sessionId: `process-probe-${crypto.randomUUID()}`,
			cwd: process.cwd(),
			parallelPoolWidth: 1,
			isolation: "process",
			processExecPath: productChild(),
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
			await expect(interruption.stateRetained).resolves.toBe(true);
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
		"When the host's executable is not bun or node (a compiled binary) and neither is on PATH, then the cell settles with a capability gap naming the runtime",
		async () => {
			const kernel = processKernel({ processCommandPath: "", processExecPath: "/opt/senpi/bin/senpi" });
			const run = await kernel.run({ cellId: "process-no-runtime", code: "return 1", timeoutMs: 5_000 });
			expect(run).toMatchObject({ ok: false });
			if (!run.ok) expect(run.error.message).toMatch(/JavaScript runtime is unavailable/);
			if (!run.ok) expect(run.error.message).toMatch(/bun|node/);
		},
		30_000,
	);

	itProcessMode(
		"When a cell writes frame-shaped lines to every fd it can reach, then each arrives as output text and none is taken as a frame",
		async () => {
			const root = await trackedTempRoot("senpi-js-process-forge-");
			const kernel = processKernel({ cwd: root });
			const forged = `${JSON.stringify({ type: "text", stream: "stdout", data: "FORGED-FRAME" })}\n`;

			const run = await runJavaScriptCell(
				kernel,
				`const fs = await import("node:fs");
const line = ${JSON.stringify(forged)};
for (let fd = 1; fd < 32; fd++) { try { fs.writeSync(fd, line); } catch {} }
return "done";`,
				10_000,
			);
			const text = run.messages.flatMap((message) => (message.type === "text" ? [message.data] : [])).join("");

			expect(run.result).toMatchObject({ ok: true, valueRepr: '"done"' });
			expect(text).toContain('"data":"FORGED-FRAME"');
			expect(text.split("FORGED-FRAME").length).toBe(text.split('"data":"FORGED-FRAME"').length);
		},
		30_000,
	);

	itProcessMode(
		"When cell code walks globals, the require cache, env and argv for the frame token, then nothing it finds forges a frame",
		async () => {
			const root = await trackedTempRoot("senpi-js-process-token-");
			const kernel = processKernel({ cwd: root });

			const run = await runJavaScriptCell(
				kernel,
				'const fs = await import("node:fs");\nconst { createRequire } = await import("node:module");\nconst found = new Set();\nconst seen = new WeakSet();\nconst visit = (value, depth) => {\n\tif (typeof value === "string") { for (const m of value.matchAll(/[0-9a-f]{32}/g)) found.add(m[0]); return; }\n\tif (value === null || (typeof value !== "object" && typeof value !== "function") || depth > 3 || seen.has(value)) return;\n\tseen.add(value);\n\tlet keys = [];\n\ttry { keys = Reflect.ownKeys(value); } catch { return; }\n\tfor (const key of keys) {\n\t\tlet inner;\n\t\ttry { inner = value[key]; } catch { continue; }\n\t\t// Under bun some prototype getters return a rejected promise; reading them must not crash the kernel.\n\t\tif (inner instanceof Promise) { try { inner.catch(() => {}); } catch {} }\n\t\tvisit(inner, depth + 1);\n\t}\n\ttry { visit(Object.getPrototypeOf(value), depth + 1); } catch {}\n};\nvisit(globalThis, 0);\nvisit(process.env, 0);\nvisit(process.argv, 0);\nvisit(process.execArgv, 0);\ntry { const require = createRequire(process.cwd() + "/"); visit(require.cache, 0); } catch {}\nfor (const candidate of found) {\n\tconst line = "\\n" + candidate + " " + JSON.stringify({ type: "text", stream: "stdout", data: "FORGED-WITH-CANDIDATE" }) + "\\n";\n\tfor (let fd = 1; fd < 32; fd++) { try { fs.writeSync(fd, line); } catch {} }\n}\nreturn found.size;',
				20_000,
			);
			const text = run.messages.flatMap((message) => (message.type === "text" ? [message.data] : [])).join("");

			expect(run.result).toMatchObject({ ok: true });
			// A candidate that were the token would make the host parse the line, delivering the bare data.
			expect(text.split("FORGED-WITH-CANDIDATE").length).toBe(text.split('"data":"FORGED-WITH-CANDIDATE"').length);
		},
		60_000,
	);

	itProcessMode(
		"When a cell writes a raw line straight to fd 1, then it arrives as output text and the next cell still runs",
		async () => {
			const root = await trackedTempRoot("senpi-js-process-raw-fd-");
			const late: string[] = [];
			const kernel = processKernel({
				cwd: root,
				onMessage: (message) => {
					if (message.type === "text") late.push(message.data);
				},
			});

			const run = await runJavaScriptCell(
				kernel,
				'(await import("node:fs")).writeSync(1, "raw line from fd 1\\n"); return "after"',
				10_000,
			);
			const next = await runJavaScriptCell(kernel, "return 1 + 1", 10_000);
			const text = () =>
				[...run.messages, ...next.messages]
					.flatMap((message) => (message.type === "text" ? [message.data] : []))
					.concat(late)
					.join("");
			await waitFor("the raw line as output text", () => text().includes("raw line from fd 1"));

			expect(run.result).toMatchObject({ ok: true, valueRepr: '"after"' });
			expect(next.result).toMatchObject({ ok: true, valueRepr: "2" });
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

	// Bun.WebView exists only when the child runs under bun (the child runs on the host's own runtime); Windows has no
	// process-mode WebView.
	if (process.platform !== "win32" && bunChild !== undefined)
		itProcessMode(
			"drives a WebView natively on the child's main thread in process mode",
			async () => {
				const kernel = processKernel({ processExecPath: bunChild ?? "" });
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

	it.each([["killed with SIGKILL"], ["exits without closing its kernel"], ["killed with SIGKILL while a cell spins"]])(
		"When the host is %s, then its process-mode kernel child is gone too",
		{ timeout: 60_000 },
		async (how) => {
			const mode = how.endsWith("spins") ? ["busy"] : [];
			// The host runs on bun, as the product does, so its kernel child is a bun child.
			const host = spawn(productChild(), [hostFixture, ...mode], { stdio: ["pipe", "pipe", "inherit"] });
			const childPid = await new Promise<number>((resolve, reject) => {
				let out = "";
				host.stdout.on("data", (data: Buffer) => {
					out += data.toString();
					const match = /child (\d+)/.exec(out);
					if (match?.[1] !== undefined) resolve(Number(match[1]));
				});
				host.once("exit", () => reject(new Error(`host exited before reporting its child: ${out}`)));
			});
			expect(pidAlive(childPid)).toBe(true);
			const hostExited = new Promise<void>((resolve) => host.once("exit", () => resolve()));

			if (how === "exits without closing its kernel") host.stdin.write("exit\n");
			else host.kill("SIGKILL");
			await hostExited;

			// A spinning cell blocks the child's main thread, so only its watchdog thread can end it: within 2 s.
			await waitFor("the kernel child to exit with its host", () => !pidAlive(childPid), 2_000);
		},
	);

	itProcessMode(
		"When a cell prints more than the 10 MiB frame limit, then the output arrives whole and the kernel keeps its globals",
		async () => {
			const kernel = processKernel();
			await runJavaScriptCell(kernel, "globalThis.keep = 1", 10_000);
			const size = 20 * 1024 * 1024;

			const big = await runJavaScriptCell(kernel, `console.log("x".repeat(${size})); "printed"`, 60_000);
			const after = await runJavaScriptCell(kernel, "return typeof globalThis.keep", 10_000);
			const printed = big.messages.flatMap((message) => (message.type === "text" ? [message.data] : [])).join("");

			expect(big.result).toMatchObject({ ok: true });
			expect(printed.length).toBeGreaterThanOrEqual(size);
			expect(after.result).toMatchObject({ ok: true, valueRepr: '"number"' });
		},
		120_000,
	);

	itProcessMode(
		"When a timer from a cell throws, then the crashed cell names the error and the next result says the kernel restarted",
		async () => {
			const kernel = processKernel();

			const crashed = await runJavaScriptCell(
				kernel,
				'setTimeout(() => { throw new Error("stray boom"); }, 0); await new Promise(() => {})',
				15_000,
			);
			const next = await runJavaScriptCell(kernel, "return 1", 15_000);

			expect(crashed.result).toMatchObject({ ok: false });
			if (!crashed.result.ok) expect(crashed.result.error.message).toContain("stray boom");
			expect(next.result).toMatchObject({ ok: true, kernelState: "restarted" });
		},
		60_000,
	);

	itProcessMode(
		"When a cell writes straight to fd 1 and returns, then the line arrives with that cell's output, before its result",
		async () => {
			const kernel = processKernel();

			const run = await runJavaScriptCell(
				kernel,
				'(await import("node:fs")).writeSync(1, "in-cell raw\\n"); return "ordered"',
				10_000,
			);
			const text = run.messages.flatMap((message) => (message.type === "text" ? [message.data] : [])).join("");

			expect(run.result).toMatchObject({ ok: true, valueRepr: '"ordered"' });
			expect(text).toContain("in-cell raw");
		},
		30_000,
	);

	// Only a bun child can point fd 0 at /dev/null; a node child shares fd 0 with the control channel.
	(bunChild === undefined ? it.skip : itProcessMode)(
		"When a cell in a bun child reads fd 0, then it reads nothing and the host can still interrupt it",
		async () => {
			const kernel = processKernel({ processExecPath: bunChild ?? "" });

			const read = await runJavaScriptCell(
				kernel,
				'return (await import("node:fs")).readFileSync("/dev/fd/0", "utf8").length',
				10_000,
			);
			const stuck = kernel.run({ cellId: "fd0-interrupt", code: "await new Promise(() => {})", timeoutMs: 10_000 });
			const interruption = await kernel.interrupt("stop", "fd0-interrupt");

			expect(read.result).toMatchObject({ ok: true, valueRepr: "0" });
			await expect(interruption.stateRetained).resolves.toBe(true);
			await expect(stuck).resolves.toMatchObject({ ok: false });
		},
		30_000,
	);

	it.each([["worker"], ["process"]] as const)(
		"When a %s-mode cell calls a host tool with a BigInt and an undefined field, then the host receives them as worker mode does",
		{ timeout: 30_000 },
		async (isolation) => {
			const kernel = isolation === "process" ? processKernel() : workerKernel();

			const pending = kernel.run({
				cellId: `parity-${isolation}`,
				code: "return await tool.read({ path: 'x', n: 1n, opts: undefined })",
				timeoutMs: 10_000,
			});
			const call = await kernel.nextToolCall();
			kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: "ok" });
			await pending;

			expect(call.args).toEqual({ path: "x", n: 1n, opts: undefined });
			expect(Object.hasOwn(call.args as object, "opts")).toBe(true);
		},
	);

	itProcessMode(
		"When a process-mode kernel starts, then its child runs on bun, the product's runtime",
		async () => {
			const kernel = processKernel();

			const run = await runJavaScriptCell(kernel, 'return typeof Bun + " " + typeof process.versions.bun', 10_000);

			expect(run.result).toMatchObject({ ok: true, valueRepr: '"object string"' });
		},
		30_000,
	);

	itProcessMode(
		"When a cell runs a child process that inherits fd 1 and prints 300 KB, then the cell settles with all of it",
		async () => {
			const kernel = processKernel();
			const script = 'process.stdout.write("y".repeat(300 * 1024))';

			const run = await runJavaScriptCell(
				kernel,
				`(await import("node:child_process")).execFileSync(process.execPath, ["-e", ${JSON.stringify(script)}], { stdio: "inherit" }); return "settled"`,
				20_000,
			);
			const text = run.messages.flatMap((message) => (message.type === "text" ? [message.data] : [])).join("");

			expect(run.result).toMatchObject({ ok: true, valueRepr: '"settled"' });
			expect(text.split("y").length - 1).toBe(300 * 1024);
		},
		60_000,
	);

	itProcessMode(
		"When a cell writes to fd 1 in a loop that ignores failed writes and returns, then the cell settles",
		async () => {
			const kernel = processKernel();

			const run = await runJavaScriptCell(
				kernel,
				'const fs = await import("node:fs"); const chunk = "z".repeat(64 * 1024); for (let i = 0; i < 64; i++) { try { fs.writeSync(1, chunk); } catch {} } return "done"',
				20_000,
			);

			expect(run.result).toMatchObject({ ok: true, valueRepr: '"done"' });
		},
		60_000,
	);

	itProcessMode(
		"When a cell returns a value whose UTF-8 form exceeds the frame limit, then the cell fails and the kernel keeps its globals",
		async () => {
			const kernel = processKernel();
			await runJavaScriptCell(kernel, "globalThis.keep = 1", 10_000);

			const big = await runJavaScriptCell(kernel, 'return "\uac00".repeat(4 * 1024 * 1024)', 60_000);
			const after = await runJavaScriptCell(kernel, "return typeof globalThis.keep", 10_000);

			expect(big.result).toMatchObject({ ok: false });
			if (!big.result.ok) expect(big.result.error.message).toContain("too large");
			expect(after.result).toMatchObject({ ok: true, valueRepr: '"number"' });
			expect(after.result).not.toHaveProperty("kernelState");
		},
		120_000,
	);

	itProcessMode(
		"When a cell calls a host tool with arguments larger than the frame limit, then the call fails in the cell at once",
		async () => {
			const kernel = processKernel();

			const run = await runJavaScriptCell(
				kernel,
				'try { await tool.read({ path: "x".repeat(12 * 1024 * 1024) }); return "sent"; } catch (error) { return error.message; }',
				15_000,
			);

			expect(run.result).toMatchObject({ ok: true });
			if (run.result.ok) expect(run.result.valueRepr).toContain("too large");
		},
		60_000,
	);

	itProcessMode(
		"When a cell sends data shaped like the value markers, then the host receives it unchanged",
		async () => {
			const kernel = processKernel();

			const pending = kernel.run({
				cellId: "marker-shaped",
				code: 'return await tool.read({ a: { "\\u0000senpi:bigint:": "abc" }, b: { "\\u0000senpi:bigint": "12" }, c: { "\\u0000senpi:undefined:": 1 } })',
				timeoutMs: 10_000,
			});
			const call = await kernel.nextToolCall();
			kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: "ok" });
			await pending;

			expect(call.args).toEqual({
				a: { "\u0000senpi:bigint:": "abc" },
				b: { "\u0000senpi:bigint": "12" },
				c: { "\u0000senpi:undefined:": 1 },
			});
		},
		30_000,
	);

	// A host on node runs a node child (the child follows the host's runtime), and node's own exit can stall: this case
	// pins that child explicitly, where every other process-mode test runs the product's bun child.
	itProcessMode(
		"When a cell in a node child crashes while waiting on a host tool, then the cell settles with the crash at once",
		async () => {
			const node = resolveJavaScriptProcessCommand(undefined, process.platform, "node", "");
			const kernel = processKernel({ processExecPath: node });
			await runJavaScriptCell(kernel, 'setTimeout(() => { throw new Error("node boom"); }, 200); "armed"', 10_000);
			const started = Date.now();

			const pending = kernel.run({
				cellId: "node-crash",
				code: "return await tool.read({ path: 'x' })",
				timeoutMs: 20_000,
			});
			await kernel.nextToolCall();
			const result = await pending;

			expect(result).toMatchObject({ ok: false });
			if (!result.ok) expect(result.error.message).toContain("node boom");
			expect(Date.now() - started).toBeLessThan(5_000);
		},
		60_000,
	);

	it("When a worker-mode cell crashes, then the next result carries no restart notice, as before process mode existed", async () => {
		const kernel = workerKernel();

		await runJavaScriptCell(
			kernel,
			'setTimeout(() => { throw new Error("worker boom"); }, 0); await new Promise(() => {})',
			15_000,
		);
		const next = await runJavaScriptCell(kernel, "return 1", 15_000);

		expect(next.result).toMatchObject({ ok: true });
		expect(next.result).not.toHaveProperty("kernelState");
		expect(next.result).not.toHaveProperty("notice");
	}, 60_000);

	it("When the runtime is resolved under native Node ESM (no injected require), then a node on PATH is found", {
		timeout: 30_000,
	}, () => {
		const node = resolveJavaScriptProcessCommand(undefined, process.platform, "node", "");
		const workerModule = join(import.meta.dirname, "..", "src", "kernels", "js", "process-worker.ts");
		const script = `const m = await import(${JSON.stringify(pathToFileURL(workerModule).href)}); process.stdout.write(m.resolveJavaScriptProcessCommand(undefined, process.platform, "node", ""));`;

		const resolved = execFileSync(
			node,
			["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
			{ encoding: "utf8" },
		);

		expect(resolved).toMatch(/(^|[\\/])node(\.exe)?$/);
	});
});
