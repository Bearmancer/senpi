import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it.each([
	"get_state",
	"get_messages",
	"get_entries",
	"get_tree",
	"get_session_stats",
	"get_commands",
	"get_loaded_surfaces",
	"memory_report",
] as const)("does not let %s polling renew a detached session's idle lifetime", async (type) => {
	// Given: a retained session whose owner detached, almost at its eviction deadline.
	const dir = await mkdtemp(join(tmpdir(), "senpi-session-observation-"));
	directories.push(dir);
	let now = 0;
	await using rig = createInProcessRig(dir, { now: () => now, idleEvictionMs: 1_000 });
	const first = opened(await rig.open("owner", { cwd: dir, retain_on_disconnect: true }), 0);
	const entry = rig.registry.peek(first.sessionId);
	if (!entry) throw new Error("Session did not open");
	await rig.drop("owner");
	now = 999;

	// When: an observer reads without attaching, then the original deadline arrives.
	await rig.send("observer", { id: "read", type, sessionId: first.sessionId });
	now = 1_000;
	rig.router.sweepIdleSessions();

	// Then: observation has not bought another idle window.
	expect(entry.state).toBe("closing");
	await entry.closeCompletion;
	expect(rig.registry.peek(first.sessionId)).toBeUndefined();
});

it.each([
	{ kind: "interactive", retained: false },
	{ kind: "interactive", retained: true },
	{ kind: "worker", retained: false },
	{ kind: "worker", retained: true },
] as const)("keeps the polled attached $kind handle usable (retained: $retained)", async ({ kind, retained }) => {
	// Given: an attached session with persisted history and an almost-expired idle window.
	const dir = await mkdtemp(join(tmpdir(), "senpi-session-observation-"));
	directories.push(dir);
	let now = 0;
	const handled: string[] = [];
	await using rig = createInProcessRig(dir, { now: () => now, idleEvictionMs: 1_000 }, async (command) => {
		handled.push(command.type);
	});
	const first = opened(
		await rig.send("owner", { id: "open", type: "open_session", cwd: dir, kind, retain_on_disconnect: retained }),
		0,
	);
	const turn = rig.turns.get(first.state.sessionFile);
	if (!turn) throw new Error("Session did not open");
	turn.finish();
	now = 999;

	// When: its owner polls before the original deadline and then uses the same handle after it.
	await rig.send("owner", { id: "poll", type: "get_state", sessionId: first.sessionId });
	now = 1_000;
	rig.router.sweepIdleSessions();
	await rig.send("owner", { id: "after", type: "get_state", sessionId: first.sessionId });

	// Then: no unsolicited teardown or routing-handle replacement occurred.
	expect(rig.registry.peek(first.sessionId)).toMatchObject({ state: "open", attachments: 1 });
	expect(handled).toEqual(["get_state", "get_state"]);
});

it("renews the idle window for a command that changes the session", async () => {
	// Given: an idle session close to its deadline.
	const dir = await mkdtemp(join(tmpdir(), "senpi-session-observation-"));
	directories.push(dir);
	let now = 0;
	await using rig = createInProcessRig(dir, { now: () => now, idleEvictionMs: 1_000 });
	const first = opened(await rig.open("owner", { cwd: dir }), 0);
	now = 999;

	// When: the client changes the name, then the old deadline passes.
	await rig.send("owner", { id: "name", type: "set_session_name", sessionId: first.sessionId, name: "active" });
	now = 1_000;
	rig.router.sweepIdleSessions();

	// Then: actual interaction still renews its lifetime.
	expect(rig.registry.peek(first.sessionId)?.state).toBe("open");
});
