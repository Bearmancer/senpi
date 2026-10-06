import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import {
	createSpawnLoggingWorkerEntry,
	removeWorkerEntry,
	type SpawnLoggingWorkerEntry,
	spawnCount,
} from "./eval/js-worker-spawn-log.ts";

const kernels = new Set<JavaScriptKernel>();
const entries = new Set<SpawnLoggingWorkerEntry>();
const servers = new Set<Server>();

afterEach(async () => {
	await Promise.all([...kernels].map(async (kernel) => await kernel.close()));
	await Promise.all([...entries].map(async (entry) => await removeWorkerEntry(entry)));
	for (const server of servers) server.closeAllConnections();
	await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
	kernels.clear();
	entries.clear();
	servers.clear();
});

async function createKernel(): Promise<{ readonly kernel: JavaScriptKernel; readonly entry: SpawnLoggingWorkerEntry }> {
	const entry = await createSpawnLoggingWorkerEntry();
	entries.add(entry);
	const kernel = new JavaScriptKernel({
		sessionId: `stop-keeps-state-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 2,
		workerEntryUrl: entry.url,
	});
	kernels.add(kernel);
	return { kernel, entry };
}

async function startedCell(
	kernel: JavaScriptKernel,
	cellId: string,
	code: string,
	onText: (text: string) => void = () => {},
) {
	const run = kernel.run({
		cellId,
		code: `await tool.started({});\n${code}`,
		timeoutMs: 60_000,
		onMessage: (message) => {
			if (message.type === "text") onText(message.data);
		},
	});
	const call = await kernel.nextToolCall();
	kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: null });
	return { run };
}

async function silentServer(): Promise<{
	readonly url: string;
	readonly requested: Promise<void>;
	readonly aborted: Promise<void>;
}> {
	const requested = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const server = createServer((request) => {
		request.once("close", () => aborted.resolve());
		requested.resolve();
	});
	servers.add(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
		requested: requested.promise,
		aborted: aborted.promise,
	};
}

/** Stops the cell, proves the kernel kept its state on the same worker, and returns the next cell's stderr. */
async function stopAndExpectStateKept(
	kernel: JavaScriptKernel,
	entry: SpawnLoggingWorkerEntry,
	run: ReturnType<JavaScriptKernel["run"]>,
): Promise<string> {
	const handle = await kernel.interrupt("user-stop");
	await expect(run).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("user-stop") } });
	await expect(handle.stateRetained).resolves.toBe(true);
	const stderr: string[] = [];
	await expect(
		kernel.run({
			cellId: "after-stop",
			code: "await new Promise((r) => setTimeout(r, 0)); return keep",
			timeoutMs: 5_000,
			onMessage: (message) => {
				if (message.type === "text" && message.stream === "stderr") stderr.push(message.data);
			},
		}),
	).resolves.toMatchObject({ ok: true, valueRepr: "41" });
	expect(await spawnCount(entry)).toBe(1);
	return stderr.join("");
}

describe("JavaScriptKernel stop on a free event loop", () => {
	it("Given a cell awaiting a promise nothing settles when stopped then earlier globals survive on the same worker", async () => {
		const { kernel, entry } = await createKernel();
		const { run } = await startedCell(kernel, "parked", "globalThis.keep = 41; await new Promise(() => {})");

		await stopAndExpectStateKept(kernel, entry, run);
	});

	it("Given a cell awaiting a fetch whose server never answers when stopped then earlier globals survive on the same worker", async () => {
		const { kernel, entry } = await createKernel();
		const server = await silentServer();
		const { run } = await startedCell(
			kernel,
			"hung-fetch",
			`globalThis.keep = 41; await fetch(${JSON.stringify(server.url)})`,
		);
		await server.requested;

		await stopAndExpectStateKept(kernel, entry, run);
		await server.aborted;
	});

	it("Given a stopped cell that resumes later when it starts a fetch then the request is refused", async () => {
		const { kernel } = await createKernel();
		const server = await silentServer();
		const { run } = await startedCell(
			kernel,
			"fetch-after-stop",
			`globalThis.keep = 41; globalThis.resume = Promise.withResolvers(); await resume.promise; globalThis.lateFetch = fetch(${JSON.stringify(server.url)}).then(() => "sent", (error) => String(error.message));`,
		);
		await kernel.interrupt("user-stop");
		await run;

		await expect(
			kernel.run({
				cellId: "after",
				code: "resume.resolve(); while (globalThis.lateFetch === undefined) await Promise.resolve(); return await lateFetch",
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ ok: true, valueRepr: '"JS cell interrupted: user-stop"' });
	});

	it("Given a polling loop when stopped then the loop stops running and earlier globals survive", async () => {
		const { kernel, entry } = await createKernel();
		const ticked = Promise.withResolvers<void>();
		const { run } = await startedCell(
			kernel,
			"poll-loop",
			"globalThis.keep = 41; globalThis.ticks = 0; for (;;) { await new Promise((resolve) => setTimeout(resolve, 10)); globalThis.ticks += 1; if (ticks === 3) print('TICKED'); }",
			(text) => {
				if (text.includes("TICKED")) ticked.resolve();
			},
		);
		await ticked.promise;

		await stopAndExpectStateKept(kernel, entry, run);
		const first = await kernel.run({ cellId: "ticks-a", code: "return ticks", timeoutMs: 5_000 });
		const second = await kernel.run({
			cellId: "ticks-b",
			code: "await new Promise((resolve) => setTimeout(resolve, 100)); return ticks",
			timeoutMs: 5_000,
		});
		expect(second).toMatchObject({ ok: true, valueRepr: first.ok ? first.valueRepr : "unreachable" });
	});

	it("Given a stopped cell that resumes later when it prints or calls a tool then nothing reaches the next cell", async () => {
		const { kernel } = await createKernel();
		const { run } = await startedCell(
			kernel,
			"late-resume",
			"globalThis.keep = 41; globalThis.resume = Promise.withResolvers(); await globalThis.resume.promise; print('LATE'); await tool.late({});",
		);
		await kernel.interrupt("user-stop");
		await run;
		const texts: string[] = [];
		const next = await kernel.run({
			cellId: "next",
			code: "globalThis.resume.resolve(); await new Promise((resolve) => setTimeout(resolve, 50)); return keep",
			timeoutMs: 5_000,
			onMessage: (message) => {
				if (message.type === "text") texts.push(message.data);
			},
		});
		expect(next).toMatchObject({ ok: true, valueRepr: "41" });
		expect(texts.join("")).not.toContain("LATE");
	});

	it.each([
		...(process.versions.bun === undefined ? [] : [["Bun.sleep", "await Bun.sleep(10)"]]),
		[
			"a short file read",
			'await (await import("node:fs/promises")).readFile(process.execPath, { length: 16 }).catch(() => {})',
		],
		[
			"a MessageChannel round trip",
			"await new Promise((resolve) => { const { port1, port2 } = new MessageChannel(); port2.onmessage = () => { port1.close(); port2.close(); resolve(); }; port1.postMessage(1); })",
		],
		["node:timers/promises", 'await (await import("node:timers/promises")).setTimeout(10)'],
		[
			"setInterval",
			"await new Promise((resolve) => { const id = setInterval(() => { clearInterval(id); resolve(); }, 10); })",
		],
	])(
		"Given a polling loop on %s when stopped then it stops ticking and earlier globals survive",
		async (_name, wait) => {
			const { kernel, entry } = await createKernel();
			const ticked = Promise.withResolvers<void>();
			const { run } = await startedCell(
				kernel,
				"poll",
				`globalThis.keep = 41; globalThis.ticks = 0; for (;;) { ${wait}; ticks += 1; if (ticks === 3) print("TICKED"); }`,
				(text) => {
					if (text.includes("TICKED")) ticked.resolve();
				},
			);
			await ticked.promise;

			await stopAndExpectStateKept(kernel, entry, run);
			const first = await kernel.run({ cellId: "ticks-a", code: "return ticks", timeoutMs: 5_000 });
			const second = await kernel.run({
				cellId: "ticks-b",
				code: "await new Promise((r) => setTimeout(r, 150)); return ticks",
				timeoutMs: 5_000,
			});
			expect(second).toMatchObject({ ok: true, valueRepr: first.ok ? first.valueRepr : "unreachable" });
		},
	);

	it("Given a stopped cell that left a fetch and a derived chain unawaited then the kernel keeps its state and does not crash", async () => {
		const { kernel, entry } = await createKernel();
		const server = await silentServer();
		const { run } = await startedCell(
			kernel,
			"floating-fetch",
			`globalThis.keep = 41; globalThis.p = fetch(${JSON.stringify(server.url)}); globalThis.q = p.then((r) => r.status); await new Promise(() => {});`,
		);
		await server.requested;

		await stopAndExpectStateKept(kernel, entry, run);
		await server.aborted;
		await expect(
			kernel.run({
				cellId: "after",
				code: "await new Promise((r) => setTimeout(r, 100)); return keep + 1",
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ ok: true, valueRepr: "42" });
		expect(await spawnCount(entry)).toBe(1);
	});

	it("Given a stopped cell with an open socket server and client when stopped then both close and earlier globals survive", async () => {
		const { kernel, entry } = await createKernel();
		const { run } = await startedCell(
			kernel,
			"sockets",
			[
				"globalThis.keep = 41;",
				'const net = await import("node:net");',
				"globalThis.srv = net.createServer(() => {}); await new Promise((r) => srv.listen(0, '127.0.0.1', r));",
				"globalThis.sock = net.createConnection(srv.address().port, '127.0.0.1'); await new Promise((r) => sock.once('connect', r));",
				"await new Promise(() => {});",
			].join(" "),
		);

		await stopAndExpectStateKept(kernel, entry, run);
		await expect(
			kernel.run({
				cellId: "after",
				code: "await new Promise((r) => setTimeout(r, 100)); return [srv.listening, sock.destroyed]",
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ ok: true, valueRepr: "[false,true]" });
	});

	it("Given a stopped cell whose floating fetch rethrows a new error with a cause then the kernel keeps its state and reports it on the next cell", async () => {
		const { kernel, entry } = await createKernel();
		const server = await silentServer();
		const { run } = await startedCell(
			kernel,
			"wrapped-fetch",
			[
				"globalThis.keep = 41;",
				`const load = async (n) => { try { return await fetch(${JSON.stringify(server.url)}); } catch (error) { throw new Error("load " + n + " failed", { cause: error }); } };`,
				"const a = load(1), b = load(2); await a; await b;",
			].join(" "),
		);
		await server.requested;

		const reported = await stopAndExpectStateKept(kernel, entry, run);
		expect(reported).toMatch(
			/Unhandled promise rejection from cell wrapped-fetch, after it was stopped: Error: load \d failed/u,
		);
		expect(reported.match(/Unhandled promise rejection/gu)).toHaveLength(1);
		await expect(kernel.run({ cellId: "after", code: "return keep + 1", timeoutMs: 5_000 })).resolves.toMatchObject({
			ok: true,
			valueRepr: "42",
		});
	});

	it("Given a cell that leaves many promises rejecting unhandled when it runs then one report and a count reach its output and the kernel keeps its state", async () => {
		const { kernel, entry } = await createKernel();
		const stderr: string[] = [];
		const result = await kernel.run({
			cellId: "burst",
			code: "globalThis.keep = 41; for (let i = 0; i < 50; i++) Promise.reject(new Error('burst ' + i)); await new Promise((r) => setTimeout(r, 50)); return 'done'",
			timeoutMs: 5_000,
			onMessage: (message) => {
				if (message.type === "text" && message.stream === "stderr") stderr.push(message.data);
			},
		});
		expect(result).toMatchObject({ ok: true });
		const text = stderr.join("");
		expect(text.match(/Unhandled promise rejection/gu)).toHaveLength(1);
		expect(text).toMatch(/Unhandled promise rejection in this cell: Error: burst 0\n\s+at /u);
		expect(text).toContain("... and 49 more unhandled promise rejections");
		await expect(kernel.run({ cellId: "after", code: "return keep", timeoutMs: 5_000 })).resolves.toMatchObject({
			ok: true,
			valueRepr: "41",
		});
		expect(await spawnCount(entry)).toBe(1);
	});

	it("Given an uncaught exception in a timer when it fires then the worker still restarts and says variables are lost", async () => {
		const { kernel, entry } = await createKernel();
		await kernel.run({ cellId: "set", code: "globalThis.keep = 41; return 1", timeoutMs: 5_000 });
		const crashed = await kernel.run({
			cellId: "fatal",
			code: "setTimeout(() => { throw new Error('fatal boom'); }, 0); await new Promise(() => {})",
			timeoutMs: 10_000,
		});
		expect(crashed).toMatchObject({ ok: false });
		const after = await kernel.run({ cellId: "after", code: "return typeof keep", timeoutMs: 10_000 });
		expect(after.ok ? after.valueRepr : after.error.message).toMatch(/"undefined"|lost/u);
		expect(await spawnCount(entry)).toBe(2);
	});

	it("Given a stopped cell that started a node:worker_threads Worker then the worker is terminated and earlier globals survive", async () => {
		const { kernel, entry } = await createKernel();
		const { run } = await startedCell(
			kernel,
			"thread",
			[
				"globalThis.keep = 41;",
				'const { Worker } = await import("node:worker_threads");',
				"globalThis.thread = new Worker('setInterval(() => {}, 1000)', { eval: true });",
				"await new Promise((resolve) => thread.once('online', resolve));",
				"await new Promise(() => {});",
			].join(" "),
		);

		await stopAndExpectStateKept(kernel, entry, run);
		await expect(
			kernel.run({
				cellId: "after",
				code: "if (thread.threadId !== -1) await new Promise((resolve) => thread.once('exit', resolve)); return thread.threadId",
				timeoutMs: 5_000,
			}),
		).resolves.toMatchObject({ ok: true, valueRepr: "-1" });
	});
});
