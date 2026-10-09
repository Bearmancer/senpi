import { afterEach, describe, expect, it, vi } from "vitest";
import * as processIdentity from "../../src/modes/app-server/daemon/process.ts";
import { hostOwnerGone } from "../../src/modes/rpc/host-daemon-state.ts";

afterEach(() => vi.restoreAllMocks());

// #3044: only a confirmed absence or a readable OS start-identity mismatch permits prompt exit.
describe("RPC owner OS identity fallback", () => {
	const owner = { pid: 42, startTime: "Fri Oct  9 12:00:00 2026" };

	it.each([
		{ observation: { kind: "absent" as const }, gone: true },
		{ observation: { kind: "present" as const, identity: owner.startTime }, gone: false },
		{ observation: { kind: "present" as const, identity: "Fri Oct  9 12:00:01 2026" }, gone: true },
		{ observation: { kind: "error" as const, error: new Error("OS query failed") }, gone: false },
		{ observation: { kind: "present" as const, identity: "unreadable" }, gone: false },
	])("reports gone=$gone for $observation", async ({ observation, gone }) => {
		vi.spyOn(processIdentity, "readProcessIdentity").mockResolvedValue(observation);
		expect(await hostOwnerGone(owner)).toBe(gone);
	});

	it("compares Windows FILETIME identities without uptime-derived estimates", async () => {
		vi.spyOn(processIdentity, "readProcessIdentity").mockResolvedValue({
			kind: "present",
			identity: "134044416000000001",
		});
		expect(await hostOwnerGone({ pid: 42, startTime: "134044416000000000" })).toBe(true);
	});
});
