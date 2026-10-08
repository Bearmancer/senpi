import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { liveSessionHolders } from "../../../src/core/session-holders.ts";
import { readProcessStartTime } from "../../../src/modes/app-server/daemon/process.ts";
import { createSessionPathReservations } from "../../../src/modes/rpc/host-reservations.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

const id = "29510000-0000-4000-8000-000000000002";
let root: string;
let file: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "held-generation-"));
	file = join(root, "session.jsonl");
	await writeFile(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

it.each([true, false])(
	"keeps a same-daemon generation's attached=%s claim semantics on an existing file",
	async (attached) => {
		await using holder = await startSessionHolder(file, id, root);
		const dir = join(root, "daemon");
		await mkdir(dir);
		await mkdir(join(dir, "generations", "old"), { recursive: true });
		await writeFile(
			join(dir, "generations", "old", "host-child.pid"),
			JSON.stringify({
				pid: holder.pid,
				processStartTime: await readProcessStartTime(holder.pid),
			}),
		);
		const old = createSessionPathReservations({ daemonDir: dir, instanceId: "old", pid: holder.pid });
		await old.claim(await realpath(file), attached);
		await writeFile(join(dir, "host.pid"), JSON.stringify({ instance_id: attached ? "old" : "new" }));
		const current = createSessionPathReservations({ daemonDir: dir, instanceId: "new" });
		const delivered: string[] = [];
		await using rig = createInProcessRig(
			root,
			undefined,
			async (command) => {
				delivered.push(command.type);
			},
			undefined,
			current,
		);
		const response = await rig.open("client", { sessionPath: file });
		if (attached) {
			expect(response).toMatchObject({
				success: false,
				error: "session_path_in_use",
				errorData: { owner: { pid: holder.pid, instanceId: "old" }, retry_after_ms: 2000 },
			});
		} else {
			expect(response).toMatchObject({ success: true });
			const sessionId = (await rig.list())[0]?.sessionId;
			if (!sessionId) throw new Error("Reclaimed session missing");
			expect(
				await rig.send("client", { type: "set_session_name", name: "reclaimed", sessionId, id: "name" }),
			).not.toMatchObject({ error: "session_held" });
			expect(delivered).toEqual(["set_session_name"]);
		}
	},
);

it("rechecks after publishing the runtime holder and rolls back an open raced by a foreign holder", async () => {
	await using rig = createInProcessRig(root);
	const open = rig.registry.openSession.bind(rig.registry);
	let holder: Awaited<ReturnType<typeof startSessionHolder>> | undefined;
	vi.spyOn(rig.registry, "openSession").mockImplementation(async (...args) => {
		const opened = await open(...args);
		expect(await liveSessionHolders(file, id)).toContainEqual({ pid: process.pid, cwd: root });
		holder = await startSessionHolder(file, id, root);
		return opened;
	});
	try {
		expect(await rig.open("client", { sessionPath: file })).toMatchObject({ success: false, error: "session_held" });
		expect(rig.registry.size).toBe(0);
		expect((await liveSessionHolders(file, id)).some((value) => value.pid === process.pid)).toBe(false);
	} finally {
		await holder?.stop();
	}
});
