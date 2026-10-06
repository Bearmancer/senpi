import { expect, it, vi } from "vitest";
import type { WorkerHostRecord } from "./rpc-host-endpoint.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// `open_session.permissionPreset` on an attach, on the production shape of a worker host: the
// session runs in a worker isolate, and its extension runs a real shell command through the
// session's bash tool, which passes the permission system like any tool call (#2823).
const BASH_PROBE = `export default function (pi) {
	pi.registerCommand("run-bash", {
		description: "run one shell command through the bash tool",
		handler: async (_args, ctx) => {
			try {
				const shell = await pi.executeTool("bash", { command: "printf permission-proof" });
				ctx.ui.notify("bash:" + (shell.content ?? []).map((block) => block.text ?? "").join(""));
			} catch (error) {
				ctx.ui.notify("bash:refused:" + (error instanceof Error ? error.message : String(error)));
			}
		},
	});
}`;

const WAIT_MS = 30_000;

type Wire = Awaited<ReturnType<Awaited<ReturnType<typeof startWorkerHost>>["connect"]>>;

/** Runs the command once, denying every permission ask; returns how many asks it raised and what bash printed. */
async function runBash(wire: Wire, sessionId: string): Promise<{ asked: number; output: string }> {
	let asked = 0;
	const prompt = wire.request({ type: "prompt", sessionId, message: "/run-bash" });
	for (;;) {
		const record: WorkerHostRecord = await wire.wait(
			(candidate) =>
				candidate.type === "extension_ui_request" &&
				((candidate.method === "select" && String(candidate.title).startsWith("Permission required:")) ||
					(candidate.method === "notify" && String(candidate.message).startsWith("bash:"))),
			WAIT_MS,
		);
		if (record.method === "notify") {
			expect((await prompt).success).toBe(true);
			return { asked, output: String(record.message) };
		}
		asked++;
		wire.send({ type: "extension_ui_response", sessionId, id: record.id, value: "Deny" });
	}
}

it("moves a live worker session to the permission preset a later attach names, keeps it when the attach names none, and treats an unknown one as open does", async () => {
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startWorkerHost(BASH_PROBE, { socket: true });
	try {
		const first = await host.connect();
		const opened = await first.request({ type: "open_session", cwd: host.cwd, permissionPreset: "full-access" });
		const sessionId = String(opened.data?.sessionId);
		const sessionPath = opened.data?.state?.sessionFile;
		expect(await runBash(first, sessionId)).toEqual({ asked: 0, output: "bash:permission-proof" });

		const second = await host.connect();
		const attach = (preset?: string) =>
			second.request({
				type: "open_session",
				cwd: host.cwd,
				sessionPath,
				...(preset === undefined ? {} : { permissionPreset: preset }),
			});
		expect((await attach("ask")).data).toMatchObject({ sessionId, attached: true });
		const strict = await runBash(first, sessionId);
		expect(strict.asked).toBe(1);
		expect(strict.output).not.toContain("permission-proof");

		expect((await attach()).data).toMatchObject({ sessionId, attached: true });
		expect((await runBash(first, sessionId)).asked).toBe(1);

		// An unknown preset: the same outcome as a session opened with it.
		const misspelled = await first.request({ type: "open_session", cwd: host.cwd, permissionPreset: "full-acess" });
		const openOutcome = await runBash(first, String(misspelled.data?.sessionId));
		expect(openOutcome.asked).toBe(0);
		expect(openOutcome.output).toContain('Permission setup failed: Invalid --permission-preset "full-acess"');
		expect((await attach("full-acess")).data).toMatchObject({ sessionId, attached: true });
		expect(await runBash(first, sessionId)).toEqual(openOutcome);

		expect((await attach("full-access")).data).toMatchObject({ sessionId, attached: true });
		expect(await runBash(first, sessionId)).toEqual({ asked: 0, output: "bash:permission-proof" });
	} finally {
		await host.dispose();
	}
}, 120_000);
