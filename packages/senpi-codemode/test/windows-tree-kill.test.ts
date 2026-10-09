import { describe, expect, it } from "vitest";
import { windowsTreeKillArgs, windowsTreeKillPids } from "../src/kernels/js/windows-tree-kill.js";

function row(pid: number, parentPid: number, createdAt: number, name = "node.exe") {
	return { pid, parentPid, createdAt: BigInt(createdAt), name };
}

const SELF = 5000;
const host = [
	row(896, 776, 100, "wininit.exe"),
	row(1008, 896, 110, "services.exe"),
	row(6952, 1008, 400, "Runner.Listener.exe"),
	row(SELF, 6952, 500, "bun.exe"),
];

describe("codemode Windows tree kill (senpi#2993)", () => {
	it("#given a kernel child on wininit's recycled parent pid #when its tree is planned #then the system tree stays out", () => {
		// given
		const rows = [...host, row(776, SELF, 600, "python.exe"), row(7100, 776, 610)];

		// when
		const pids = windowsTreeKillPids(rows, 776, SELF);

		// then
		expect([...pids].sort((a, b) => a - b)).toEqual([776, 7100]);
	});

	it("#given a protected image under the root #when planned #then only the root is killed", () => {
		// given
		const rows = [...host, row(7000, SELF, 600, "python.exe"), row(7400, 7000, 610, "svchost.exe")];

		// when / then
		expect(windowsTreeKillPids(rows, 7000, SELF)).toEqual([7000]);
	});

	it("#given the root is an ancestor of this process #when planned #then nothing is killed", () => {
		// when / then
		expect(windowsTreeKillPids(host, 6952, SELF)).toEqual([]);
	});

	it("#given a listing or none #when kill args are built #then pids are named without /T, or /T on the root alone", () => {
		// given
		const rows = [...host, row(7000, SELF, 600), row(7010, 7000, 610)];

		// when / then
		expect(windowsTreeKillArgs(7000, rows, SELF)).toEqual(["/F", "/PID", "7000", "/PID", "7010"]);
		expect(windowsTreeKillArgs(7000, undefined, SELF)).toEqual(["/F", "/T", "/PID", "7000"]);
	});
});
