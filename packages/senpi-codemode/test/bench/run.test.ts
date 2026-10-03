import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { decide } from "../../scripts/bench-compare.ts";
import { type RunPlan, runBlocks } from "../../scripts/bench-run.ts";

vi.mock("node:os", async (original) => ({
	...(await original<typeof import("node:os")>()),
	loadavg: () => [0, 0, 0],
}));

const plan: RunPlan = {
	targets: { base: "base-fixture", head: "head-fixture" },
	runtimes: [{ id: "js-bun", language: "js", jsRuntime: "bun" }],
	blocks: 3,
	reps: 3,
	scriptRoot: fileURLToPath(new URL("./runtime-fixture", import.meta.url)),
	env: process.env,
	log: () => {},
};

describe("paired runtime scheduling", () => {
	it("keeps each paired repetition adjacent when runtime processes are retained", async () => {
		// Given real subprocesses whose measurement replies arrive only on request.
		// When three complete blocks run through the production benchmark scheduler.
		const run = await runBlocks(plan);
		// Then every base/head and calibration pair shares the same local measurement window.
		expect(run.failures).toEqual([]);
		for (const block of run.blocks) {
			const measured = block.measurements.filter(({ rep }) => rep >= 0);
			for (let index = 0; index < measured.length; index += 2) {
				const first = measured[index];
				const second = measured[index + 1];
				if (!first || !second) throw new Error("paired measurement missing");
				expect(second.scenario).toBe(first.scenario);
				expect(second.rep).toBe(first.rep);
				if (first.role === "comparison") {
					expect(second.role).toBe("comparison");
					expect(second.side).not.toBe(first.side);
				} else {
					expect(second.role).not.toBe(first.role);
					expect(second.side).toBe("base");
				}
			}
			const firstComparison = measured.find(({ rep, role }) => rep === 0 && role === "comparison");
			expect(firstComparison?.side).toBe(block.index % 2 === 0 ? "base" : "head");
		}
		expect(decide({ ...run, blockLoads: run.admissionLoads }).exitCode).toBe(0);
		// And every block records an ordered wall-clock window, so host activity can be checked for overlap.
		const windows = run.blocks.map((block) => [Date.parse(block.startedAt), Date.parse(block.endedAt)] as const);
		for (const [index, [start, end]] of windows.entries()) {
			expect(end).toBeGreaterThanOrEqual(start);
			expect(start).toBeGreaterThanOrEqual(windows[index - 1]?.[1] ?? start);
		}
	}, 30_000);

	it("invalidates a run when a runtime exits before its requested sample", async () => {
		// Given a runtime that exits cleanly without its promised reply.
		const broken = { ...plan, env: { ...process.env, BENCH_FIXTURE_FAILURE: "exit" } };
		// When the scheduler requests the first sample.
		const run = await runBlocks(broken);
		// Then completion without measurement cannot silently pass or hang.
		expect(run.failures.length).toBeGreaterThan(0);
		expect(decide({ ...run, blockLoads: run.admissionLoads }).exitCode).toBe(3);
	}, 30_000);
});
