import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { watchExitUsage } from "../../scripts/bench-accounting.ts";
import { kernelCpuMs } from "../../scripts/bench-measure.ts";

describe("benchmark process accounting", () => {
	it("drains a registered interpreter even without a live CPU probe", async () => {
		// Given a started interpreter and a collector subscribed before retirement.
		const root = await mkdtemp(join(tmpdir(), "bench-receipt-"));
		await writeFile(join(root, "started-101"), "");
		const accounting = watchExitUsage(root);
		try {
			// When teardown starts before the collector atomically publishes usage.
			const draining = accounting.totals();
			await writeFile(join(root, "pending-101.json"), JSON.stringify({ pid: 101, cpuUs: 75_000 }));
			await rename(join(root, "pending-101.json"), join(root, "usage-101.json"));
			// Then teardown retains the usage instead of racing directory removal.
			expect(kernelCpuMs([], await draining)).toBe(75);
		} finally {
			accounting.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an incomplete window when the old interpreter disappears", () => {
		// Given a process that consumed CPU before the measurement window.
		const before = [{ pid: 101, cpuUs: 500_000 }];
		const after = [{ pid: 102, cpuUs: 25_000 }];
		// When its replacement is the only available observation.
		// Then missing exit usage must not masquerade as measured CPU.
		expect(() => kernelCpuMs(before, after)).toThrow(/101/);
	});

	it("counts the exited interpreter and its replacement once", () => {
		// Given final usage from the waiter and a live replacement snapshot.
		const before = [{ pid: 101, cpuUs: 500_000 }];
		const after = [
			{ pid: 101, cpuUs: 550_000 },
			{ pid: 102, cpuUs: 25_000 },
		];
		// When the measurement window is reduced.
		const cpuMs = kernelCpuMs(before, after);
		// Then only CPU consumed inside the window contributes.
		expect(cpuMs).toBe(75);
	});
});
