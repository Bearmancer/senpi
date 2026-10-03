import { afterEach, describe, expect, it, vi } from "vitest";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { FakeChild } from "./py-kernel/fixtures.ts";

afterEach(() => vi.useRealTimers());

describe("Python startup progress", () => {
	it("waits for ready when bootstrap stages exceed the old total deadline", async () => {
		// Given: an interpreter whose individual stages progress, but take 12 seconds in total.
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "slow-bootstrap",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 5_000,
			spawnProcess: () => child,
		});
		const outcome = started.then(
			(kernel) => ({ kernel }),
			(error: unknown) => ({ error }),
		);

		// When: each next stage arrives before the per-stage hang guard, followed by ready.
		for (const stage of ["stdlib-imports", "runtime-init", "host-init"]) {
			await vi.advanceTimersByTimeAsync(4_000);
			child.emitMessage({ type: "status", event: { op: "kernel-startup", stage } });
		}
		child.emitMessage({ type: "ready" });
		const result = await outcome;

		// Then: the actual ready event admits the kernel without killing it.
		expect("kernel" in result).toBe(true);
		expect(child.killSignals).toEqual([]);
		if ("kernel" in result) await result.kernel.close();
	});

	it("names the last stage and retires the child when that stage hangs", async () => {
		// Given: an interpreter that reaches imports but never progresses.
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "hung-bootstrap",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			spawnProcess: () => child,
		});
		const outcome = started.catch((error: unknown) => error);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "stdlib-imports" } });
		child.stderr.write("import diagnostic\n");

		// When: no next-stage or ready event arrives within the hang guard.
		await vi.advanceTimersByTimeAsync(200);

		// Then: the error identifies the stalled stage, and the owned child is retired.
		const error = await outcome;
		expect(error).toMatchObject({
			stage: "stdlib-imports",
			message: expect.stringContaining("import diagnostic"),
		});
		expect(error instanceof Error && error.message).toContain("stdlib-imports");
		expect(child.killSignals).toEqual(["SIGKILL"]);
	});

	it("does not extend a hung stage for repeated progress frames", async () => {
		// Given: an interpreter stuck in imports.
		vi.useFakeTimers();
		const child = new FakeChild({ autoReady: false });
		const started = PythonKernel.start({
			interpreterPath: "python3",
			sessionId: "repeated-stage",
			cwd: process.cwd(),
			connection: { port: 1, token: "fixture" },
			startupTimeoutMs: 200,
			spawnProcess: () => child,
		});
		const outcome = started.catch((error: unknown) => error);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "stdlib-imports" } });

		// When: repeated and unknown stages arrive instead of an advancing stage.
		await vi.advanceTimersByTimeAsync(150);
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "stdlib-imports" } });
		child.emitMessage({ type: "status", event: { op: "kernel-startup", stage: "unknown" } });
		await vi.advanceTimersByTimeAsync(50);

		// Then: these frames cannot keep the child alive indefinitely.
		expect(await outcome).toMatchObject({ stage: "stdlib-imports" });
		expect(child.killSignals).toEqual(["SIGKILL"]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
