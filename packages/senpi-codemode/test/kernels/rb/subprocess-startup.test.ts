import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBridgeFrame, encodeBridgeFrame, type KernelToHostMessage } from "../../../src/bridge/protocol.ts";
import { SubprocessKernel } from "../../../src/kernels/shared/subprocess-kernel.ts";
import { SubprocessStartupWatchdog } from "../../../src/kernels/shared/subprocess-startup.ts";

const NO_PROGRESS_MS = 30_000;
// Above every platform's pid_max: signalling this "process group" finds nothing and falls back to child.kill.
const FAKE_PID = 2 ** 30;

function stage(name: string): KernelToHostMessage {
	return { type: "status", event: { op: "kernel-startup", stage: name } } as KernelToHostMessage;
}

class SilentInterpreter extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = FAKE_PID;
	answerInit = false;
	readonly stdin = {
		write: (chunk: string): boolean => {
			const decoded = decodeBridgeFrame(chunk);
			if (decoded.ok && decoded.message.type === "init" && this.answerInit) this.say({ type: "ready" });
			return true;
		},
	};

	say(message: KernelToHostMessage): void {
		this.stdout.write(encodeBridgeFrame(message));
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}
}

describe("SubprocessStartupWatchdog", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("Given a runner that prints nothing but keeps using CPU when the no-progress window passes again and again then it never stalls", () => {
		let cpu = 0n;
		const onStall = vi.fn();
		const watchdog = new SubprocessStartupWatchdog(
			{ label: "Julia", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => (cpu += 1_000n) },
			FAKE_PID,
			onStall,
		);

		vi.advanceTimersByTime(10 * NO_PROGRESS_MS);

		expect(onStall).not.toHaveBeenCalled();
		watchdog.stop();
	});

	it("Given a runner that is silent and uses no CPU after reaching runtime-init when the window passes then it stalls once, naming that stage", () => {
		const onStall = vi.fn();
		const watchdog = new SubprocessStartupWatchdog(
			{ label: "Ruby", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => 500n },
			FAKE_PID,
			onStall,
		);
		watchdog.observe(stage("stdlib-imports"));
		watchdog.observe(stage("runtime-init"));

		vi.advanceTimersByTime(NO_PROGRESS_MS - 1);
		expect(onStall).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		vi.advanceTimersByTime(5 * NO_PROGRESS_MS);

		expect(onStall).toHaveBeenCalledTimes(1);
		expect(onStall.mock.calls[0]?.[0]).toContain("Ruby kernel stalled at runtime-init");
	});

	it("Given a runner whose CPU stopped moving after a burst when the next window passes then it stalls", () => {
		const readings = [100n, 200n, 300n];
		const onStall = vi.fn();
		const watchdog = new SubprocessStartupWatchdog(
			{ label: "Julia", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => readings.shift() ?? 300n },
			FAKE_PID,
			onStall,
		);

		vi.advanceTimersByTime(2 * NO_PROGRESS_MS);
		expect(onStall).not.toHaveBeenCalled();
		vi.advanceTimersByTime(NO_PROGRESS_MS);

		expect(onStall).toHaveBeenCalledTimes(1);
		expect(onStall.mock.calls[0]?.[0]).toContain("stalled at interpreter-launch");
		watchdog.stop();
	});

	it("Given output lines keep arriving with no CPU reader when the window passes between them then it never stalls", () => {
		const onStall = vi.fn();
		const watchdog = new SubprocessStartupWatchdog(
			{ label: "Ruby", noProgressMs: NO_PROGRESS_MS },
			FAKE_PID,
			onStall,
		);

		for (let line = 0; line < 10; line += 1) {
			vi.advanceTimersByTime(NO_PROGRESS_MS - 1);
			watchdog.observe({ type: "text", stream: "stderr", data: "warming\n" });
		}

		expect(onStall).not.toHaveBeenCalled();
		watchdog.stop();
	});
});

describe("SubprocessKernel startup", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("Given an interpreter stuck silent and idle in runtime-init when a cell is waiting then the cell fails with a startup error naming the stage", async () => {
		const interpreter = new SilentInterpreter();
		const kernel = new SubprocessKernel({
			command: "ruby",
			args: [],
			sessionId: "rb-stalled",
			connection: { port: 1, token: "t" },
			spawn: () => interpreter as never,
			startup: { label: "Ruby", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => 7n },
		});
		interpreter.say(stage("runtime-init"));
		await vi.advanceTimersByTimeAsync(0);

		const cell = kernel.run({ cellId: "waits", code: "1" });
		const settled = expect(cell).resolves.toMatchObject({ ok: false });
		await vi.advanceTimersByTimeAsync(NO_PROGRESS_MS);
		await settled;
		const result = await cell;
		if (!result.ok) expect(result.error.message).toContain("Ruby kernel stalled at runtime-init");
		await kernel.close().catch(() => undefined);
	});

	it("Given an interpreter that becomes ready after a long silent but CPU-busy start when a cell runs then it runs normally", async () => {
		const interpreter = new SilentInterpreter();
		let cpu = 0n;
		const kernel = new SubprocessKernel({
			command: "julia",
			args: [],
			sessionId: "jl-slow",
			connection: { port: 1, token: "t" },
			spawn: () => interpreter as never,
			startup: { label: "Julia", noProgressMs: NO_PROGRESS_MS, readGroupCpuTime: () => (cpu += 10n) },
		});
		await vi.advanceTimersByTimeAsync(5 * NO_PROGRESS_MS);

		interpreter.answerInit = true;
		interpreter.say({ type: "ready" });
		await vi.advanceTimersByTimeAsync(0);
		const cell = kernel.run({ cellId: "after-slow-start", code: "1" });
		await vi.advanceTimersByTimeAsync(0);
		interpreter.say({ type: "result", cellId: "after-slow-start", ok: true, valueRepr: "1", durationMs: 1 });

		await expect(cell).resolves.toMatchObject({ ok: true });
		await kernel.close().catch(() => undefined);
	});
});
