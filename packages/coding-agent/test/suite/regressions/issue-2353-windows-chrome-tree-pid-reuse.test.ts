import { describe, expect, it } from "vitest";
import {
	bunChromeTree,
	parseWindowsProcessRows,
	type WindowsProcessRow,
} from "../../../src/core/webview/windows-chrome-tree.ts";

const DEAD_BOOT_PARENT = 776;
const WININIT = 896;
const SERVICES = 1008;
const SVCHOST = 2640;
const HOSTED_COMPUTE_AGENT = 9392;
const RUNNER_LISTENER = 6952;
const RUNNER_WORKER = 6236;
const BUN = 5000;

function row(pid: number, parentPid: number, createdAt: number, bunChromeFlag = false): WindowsProcessRow {
	return { pid, parentPid, createdAt: BigInt(createdAt), bunChromeFlag };
}

// The ancestry a hosted windows-latest runner reports (senpi#2353 probe): wininit.exe names a parent
// that exited at boot, and the runner itself descends from wininit.exe.
const runner = [
	row(WININIT, DEAD_BOOT_PARENT, 100),
	row(SERVICES, WININIT, 110),
	row(SVCHOST, SERVICES, 200),
	row(HOSTED_COMPUTE_AGENT, SVCHOST, 300),
	row(RUNNER_LISTENER, HOSTED_COMPUTE_AGENT, 400),
	row(RUNNER_WORKER, RUNNER_LISTENER, 410),
	row(BUN, RUNNER_WORKER, 500),
];
const runnerPids = runner.map((process) => process.pid);

describe("Bun's Chrome tree on Windows (senpi#2353)", () => {
	it("#given a Chrome helper handed the recycled pid of wininit's dead parent #when the tree is listed #then the runner's processes stay out", () => {
		// given
		const rows = [...runner, row(7000, BUN, 600, true), row(DEAD_BOOT_PARENT, 7000, 610), row(7100, 7000, 620)];

		// when
		const tree = bunChromeTree(rows, BUN);

		// then
		expect(tree.sort((a, b) => a - b)).toEqual([DEAD_BOOT_PARENT, 7000, 7100]);
		for (const pid of runnerPids) expect(tree).not.toContain(pid);
	});

	it("#given a Chrome browser older than Bun that names Bun's recycled pid #when the tree is listed #then it is not Bun's", () => {
		// given
		const rows = [...runner, row(7200, BUN, 450, true)];

		// when
		const tree = bunChromeTree(rows, BUN);

		// then
		expect(tree).toEqual([]);
	});

	it("#given Bun's Chrome with nested helpers and an unflagged sibling #when the tree is listed #then exactly the browser and its descendants are included", () => {
		// given
		const rows = [
			...runner,
			row(7000, BUN, 600, true),
			row(7010, 7000, 610),
			row(7020, 7010, 620),
			row(7030, BUN, 630),
		];

		// when
		const tree = bunChromeTree(rows, BUN);

		// then
		expect(tree.sort((a, b) => a - b)).toEqual([7000, 7010, 7020]);
	});

	it("#given PowerShell output with CRLF, blank lines and FILETIMEs beyond 2^53 #when parsed #then rows keep exact creation times", () => {
		// given
		const stdout = "896 776 134046261411081720 0\r\n\r\n7000 5000 134046263569141430 1\r\nnot a row\r\n";

		// when
		const rows = parseWindowsProcessRows(stdout);

		// then
		expect(rows).toEqual([
			{ pid: 896, parentPid: 776, createdAt: 134046261411081720n, bunChromeFlag: false },
			{ pid: 7000, parentPid: 5000, createdAt: 134046263569141430n, bunChromeFlag: true },
		]);
	});
});
