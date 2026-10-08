import * as childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as daemonProcess from "../../../src/modes/app-server/daemon/process.ts";
import { createSessionPathReservations } from "../../../src/modes/rpc/host-reservations.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

vi.mock("node:child_process", { spy: true });

const durableId = "29510000-0000-4000-8000-000000000021";
let root: string;
let file: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "held-cost-"));
	file = join(root, "session.jsonl");
	await writeFile(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: durableId, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

// senpi#2951: admission cost is bounded by distinct foreign processes, not claim count.
it.each([1, 10, 30])(
	"spawns no processes for a writing command with %s own claims and no foreign holder",
	async (count) => {
		const reservations = createSessionPathReservations({ daemonDir: join(root, "daemon"), instanceId: "current" });
		for (let index = 0; index < count; index++) await reservations.claim(join(root, `own-${index}.jsonl`));
		const delivered: string[] = [];
		await using rig = createInProcessRig(root, undefined, async (command) => {
			delivered.push(command.type);
		});
		await rig.open("client", { sessionPath: file });
		const sessionId = (await rig.list())[0]?.sessionId;
		if (!sessionId) throw new Error("Session did not open");
		const family = vi
			.spyOn(rig.registry, "holderPids")
			.mockImplementation((starts) => reservations.holderPids?.(starts) ?? Promise.resolve([]));
		const asynchronous = vi.mocked(childProcess.execFile);
		const synchronous = vi.mocked(childProcess.execFileSync);
		asynchronous.mockClear();
		synchronous.mockClear();
		await rig.send("client", { type: "set_session_name", id: "write", sessionId, name: "not held" });
		expect(delivered).toEqual(["set_session_name"]);
		expect(await rig.open("another", { sessionPath: file })).toMatchObject({ success: true });
		expect(asynchronous).not.toHaveBeenCalled();
		expect(synchronous).not.toHaveBeenCalled();
		expect(family).not.toHaveBeenCalled();
	},
);

it("resolves a foreign-looking daemon once, deduplicates its claims and never probes the host pid", async () => {
	const delivered: string[] = [];
	await using rig = createInProcessRig(root, undefined, async (command) => {
		delivered.push(command.type);
	});
	await rig.open("client", { sessionPath: file });
	const sessionId = (await rig.list())[0]?.sessionId;
	if (!sessionId) throw new Error("Session did not open");
	await using holder = await startSessionHolder(file, durableId, root);
	const daemonDir = join(root, "daemon");
	const predecessor = createSessionPathReservations({ daemonDir, instanceId: "previous", pid: holder.pid });
	await predecessor.claim(file);
	for (let index = 0; index < 10; index++) await predecessor.claim(join(root, `previous-${index}.jsonl`));
	const current = createSessionPathReservations({ daemonDir, instanceId: "current" });
	for (let index = 0; index < 10; index++) await current.claim(join(root, `current-${index}.jsonl`));
	const family = vi
		.spyOn(rig.registry, "holderPids")
		.mockImplementation((starts) => current.holderPids?.(starts) ?? Promise.resolve([]));
	const identity = vi.spyOn(daemonProcess, "readProcessStartTime");
	const processes = vi.mocked(childProcess.execFile);
	processes.mockClear();
	await rig.send("client", { type: "switch_session", id: "switch", sessionId, sessionPath: file });
	expect(delivered).toEqual(["switch_session"]);
	expect(family).toHaveBeenCalledTimes(1);
	expect(identity).not.toHaveBeenCalled();
	expect(processes).toHaveBeenCalledTimes(process.platform === "linux" ? 0 : 1);
	family.mockClear();
	processes.mockClear();
	expect(await rig.open("another", { sessionPath: file })).toMatchObject({ success: true });
	expect(family).toHaveBeenCalledTimes(1);
	expect(identity).not.toHaveBeenCalled();
	expect(processes).toHaveBeenCalledTimes(process.platform === "linux" ? 0 : 1);
});
