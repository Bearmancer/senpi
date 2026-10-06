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

async function silentServer(): Promise<{ readonly url: string; readonly requested: Promise<void> }> {
	const requested = Promise.withResolvers<void>();
	const server = createServer(() => requested.resolve());
	servers.add(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, requested: requested.promise };
}

async function stopAndExpectStateKept(
	kernel: JavaScriptKernel,
	entry: SpawnLoggingWorkerEntry,
	run: ReturnType<JavaScriptKernel["run"]>,
): Promise<void> {
	const handle = await kernel.interrupt("user-stop");
	await expect(run).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("user-stop") } });
	await expect(handle.stateRetained).resolves.toBe(true);
	await expect(kernel.run({ cellId: "after-stop", code: "return keep", timeoutMs: 5_000 })).resolves.toMatchObject({
		ok: true,
		valueRepr: "41",
	});
	expect(await spawnCount(entry)).toBe(1);
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
});
