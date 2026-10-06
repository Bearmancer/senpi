/**
 * #2823: an `open_session` that attaches to a live session moves it to the `permissionPreset` it
 * names, from the next tool call on, in both directions; an attach without one keeps the live
 * preset, and an unknown one is refused without changing anything.
 *
 * Runs the real in-process host core (registry, router, writer) over the real
 * `createCliRuntimeFactory`, so the builtin permission extension loads as in a host session. Only
 * the model is faked: every turn calls `bash` once. A permission ask reaches the clients as an
 * `extension_ui_request` select titled "Permission required: ...", which the test denies.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

const isPermissionAsk = (record: WireRecord): boolean =>
	record.type === "extension_ui_request" &&
	record.method === "select" &&
	String(record.title ?? "").startsWith("Permission required:");

async function attachHost() {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-2823-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	// The session's commands run through the `bash` tool, not an eval cell.
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ disabledBuiltinExtensions: ["codemode"] }));
	const faux = fauxProvider({ api: "fauxattach", provider: "fauxattach" });
	const model = faux.getModel();
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-skills",
		"--no-context-files",
		"--provider",
		model.provider,
		"--model",
		model.id,
		"--api-key",
		"faux-key",
	]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "rpc" },
			{ extensionFactories: [(pi) => pi.registerProvider(faux.provider)] },
		),
		closeGraceMs: 1_000,
	});
	const records: WireRecord[] = [];
	const listeners = new Set<(record: WireRecord) => void>();
	const observe = (line: string): void => {
		const record = JSON.parse(line) as WireRecord;
		records.push(record);
		for (const listener of [...listeners]) listener(record);
	};
	const writer = new SessionEventWriter(observe);
	for (const connection of ["first", "second"])
		writer.registerConnection(connection, { writeRaw: observe, waitForBackpressure: async () => {} });
	const router = new SessionCommandRouter(registry, writer, { cwd });
	let serial = 0;
	const send = async (connection: string, frame: Record<string, unknown>): Promise<WireRecord | undefined> => {
		const id = `req-${++serial}`;
		const command = JSON.parse(JSON.stringify({ ...frame, id })) as RpcCommand;
		const direct = await writer.withConnection(connection, () => router.handle(command));
		await writer.flush();
		return (direct as WireRecord | undefined) ?? records.find((record) => record.id === id);
	};
	disposers.push(async () => {
		await router.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	const sessionPath = join(scratch, "thread.jsonl");
	return {
		registry,
		/** Opens (or attaches to) the shared thread file from `connection`; `preset` absent sends none. */
		async open(connection: string, preset?: string): Promise<WireRecord | undefined> {
			return send(connection, {
				type: "open_session",
				cwd,
				sessionPath,
				retain_on_disconnect: true,
				...(preset === undefined ? {} : { permissionPreset: preset }),
			});
		},
		/** One turn whose model calls `bash`; returns the permission asks it raised and whether the command ran. */
		async runBash(sessionId: string): Promise<{ asked: number; ran: boolean }> {
			const start = records.length;
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "printf permission-proof" }, { id: "call-1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const denier = (record: WireRecord): void => {
				if (record.sessionId !== sessionId || !isPermissionAsk(record)) return;
				void send("first", {
					type: "extension_ui_response",
					uiRequestId: String(record.id),
					sessionId,
					value: "Deny",
				});
			};
			listeners.add(denier);
			const idle = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Deadline waiting for agent_idle")), 60_000);
				const onIdle = (record: WireRecord): void => {
					if (record.type !== "agent_idle" || record.sessionId !== sessionId) return;
					clearTimeout(timer);
					listeners.delete(onIdle);
					resolve();
				};
				listeners.add(onIdle);
			});
			const prompted = await send("first", { type: "prompt", sessionId, message: "go" });
			if (prompted?.success === false) throw new Error(`prompt failed: ${String(prompted.error)}`);
			await idle;
			await registry.peek(sessionId)?.runtime?.session.waitForSettledSessionWork();
			listeners.delete(denier);
			const turn = records.slice(start).filter((record) => record.sessionId === sessionId);
			const end = turn.find((record) => record.type === "tool_execution_end");
			return {
				asked: turn.filter(isPermissionAsk).length,
				ran: ranText(end),
			};
		},
	};
}

/** The bash result text is exactly the command's output when it ran. */
function ranText(end: WireRecord | undefined): boolean {
	const result = end?.result as { content?: Array<{ type: string; text?: string }> } | undefined;
	return (result?.content ?? []).some((block) => block.type === "text" && block.text === "permission-proof");
}

function sessionIdOf(record: WireRecord | undefined): string {
	const sessionId = (record?.data as { sessionId?: string } | undefined)?.sessionId;
	if (!sessionId) throw new Error(`open_session failed: ${JSON.stringify(record)}`);
	return sessionId;
}

describe("an attach moves the live session to the permission preset it names (#2823)", () => {
	it("enforces ask from the next tool call after a full-access session is attached with ask, and full-access again after the reverse", async () => {
		const host = await attachHost();
		const sessionId = sessionIdOf(await host.open("first", "full-access"));
		expect(await host.runBash(sessionId)).toEqual({ asked: 0, ran: true });

		const attached = await host.open("second", "ask");
		expect(attached?.data).toMatchObject({ sessionId, attached: true });
		expect(await host.runBash(sessionId)).toEqual({ asked: 1, ran: false });

		await host.open("second", "full-access");
		expect(await host.runBash(sessionId)).toEqual({ asked: 0, ran: true });
	}, 120_000);

	it("keeps the live preset when an attach names none", async () => {
		const host = await attachHost();
		const sessionId = sessionIdOf(await host.open("first", "ask"));
		expect(await host.runBash(sessionId)).toEqual({ asked: 1, ran: false });

		expect((await host.open("second"))?.data).toMatchObject({ sessionId, attached: true });
		expect(await host.runBash(sessionId)).toEqual({ asked: 1, ran: false });
	}, 120_000);

	it("refuses an attach naming an unknown preset and leaves the session on its preset and attachments", async () => {
		const host = await attachHost();
		const sessionId = sessionIdOf(await host.open("first", "ask"));
		const attachments = host.registry.peek(sessionId)?.attachments;

		const refused = await host.open("second", "full-acess");
		expect(refused?.success).toBe(false);
		expect(String(refused?.error)).toContain('Invalid --permission-preset "full-acess"');
		expect(host.registry.peek(sessionId)?.attachments).toBe(attachments);
		expect(await host.runBash(sessionId)).toEqual({ asked: 1, ran: false });
	}, 120_000);
});
