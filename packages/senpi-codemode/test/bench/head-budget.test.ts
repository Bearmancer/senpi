import { describe, expect, it } from "vitest";
import { type BenchInput, decide, type PairedBlock, type Rep, type Series } from "../../scripts/bench-compare.ts";
import { HEAD_BUDGETS } from "../../scripts/bench-head-budget.ts";

const RECOVERED = { queuedOk: 100, queuedFailed: 0, idsExecuted: 100, maxExecutionsPerId: 1, replacements: 1 };
const NO_RECOVERY = { queuedOk: 0, queuedFailed: 100, idsExecuted: 0, maxExecutionsPerId: 0, replacements: 0 };

function rep(wallMs: number, observations: Rep["observations"]): Rep {
	return { cpuMs: wallMs, wallMs, observations };
}

/** Base fails every queued cell in ~20 ms; the head recovers and runs them all. */
function crashBlocks(headWallMs: number, headObservations: Rep["observations"] = RECOVERED): readonly PairedBlock[] {
	return Array.from({ length: 3 }, () => ({
		first: [20, 21, 19].map((wall) => rep(wall, NO_RECOVERY)),
		second: [headWallMs, headWallMs * 1.01, headWallMs * 0.99].map((wall) => rep(wall, headObservations)),
	}));
}

function calibration(): readonly PairedBlock[] {
	return Array.from({ length: 3 }, () => ({
		first: [20, 21, 19].map((wall) => rep(wall, NO_RECOVERY)),
		second: [20.1, 21.1, 19.1].map((wall) => rep(wall, NO_RECOVERY)),
	}));
}

function inputFor(runtimeId: string, comparison: readonly PairedBlock[]): BenchInput {
	const series: Series = {
		scenario: "crash-queue-100",
		runtimeId,
		present: { base: true, head: true },
		calibration: calibration(),
		comparison,
	};
	return {
		reps: 3,
		runtimes: ["js-bun", "js-node", "py", "rb", "jl"].map((id) => ({
			id,
			base: { available: true, version: "same-version" },
			head: { available: true, version: "same-version" },
		})),
		blockLoads: [1, 1, 1],
		series: [series],
	};
}

describe("crash-queue-100 absolute head budget (rb, jl)", () => {
	it("passes a head that recovers and runs every queued cell under the ceiling, although the base ratio is ~20x", () => {
		// Given the 2026-10-09 shape: the base fails all 100 cells in ~20 ms, the head recovers in ~410 ms.
		// When the comparator gates crash-queue-100 on rb.
		const result = decide(inputFor("rb", crashBlocks(410)));
		// Then the row is judged on the head budget, not the ratio.
		expect(result.exitCode).toBe(0);
		const wall = result.results.find((row) => row.metric === "wall");
		expect(wall?.ratio).toBeGreaterThan(15);
		expect(wall?.verdict).toBe("PASS");
		expect(wall?.headBudget?.violations).toEqual([]);
	});

	it("fails a head that leaves a queued cell unrun", () => {
		// Given a head where the recovery path dropped one queued cell.
		const dropped = { ...RECOVERED, queuedOk: 99, queuedFailed: 1, idsExecuted: 99 };
		// When the comparator gates crash-queue-100 on jl.
		const result = decide(inputFor("jl", crashBlocks(1300, dropped)));
		// Then the run fails and names the missing work.
		expect(result.exitCode).toBe(1);
		expect(result.lines.join("\n")).toContain("queuedOk 99 (expected 100)");
	});

	it("fails a head that runs a queued cell twice", () => {
		// Given a head where recovery replayed a cell.
		const replayed = { ...RECOVERED, maxExecutionsPerId: 2 };
		// When the comparator gates crash-queue-100 on rb.
		const result = decide(inputFor("rb", crashBlocks(410, replayed)));
		// Then the duplicate execution is a failure.
		expect(result.exitCode).toBe(1);
		expect(result.lines.join("\n")).toContain("maxExecutionsPerId 2 (expected 1)");
	});

	it("fails a head whose median wall time exceeds the ceiling", () => {
		// Given a complete recovery that became slow on rb.
		const ceiling = HEAD_BUDGETS.find((budget) => budget.runtimeId === "rb")?.maxMedianWallMs ?? 0;
		// When the head's median wall is above the ceiling.
		const result = decide(inputFor("rb", crashBlocks(ceiling * 1.2)));
		// Then the slowdown fails even though every cell ran.
		expect(result.exitCode).toBe(1);
		expect(result.lines.join("\n")).toContain(`> ceiling ${ceiling} ms`);
	});

	it("keeps the base-ratio gate for runtimes without a budget", () => {
		// Given the same shape on py, which has no head budget.
		// When the comparator gates it.
		const result = decide(inputFor("py", crashBlocks(410)));
		// Then the ~20x ratio still fails as before.
		expect(result.exitCode).toBe(1);
		expect(result.results.every((row) => row.headBudget === undefined)).toBe(true);
	});
});
