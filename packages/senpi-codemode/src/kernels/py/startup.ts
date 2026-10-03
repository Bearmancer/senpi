import type { KernelToHostMessage } from "../../bridge/protocol.ts";

// Fresh-cache Windows bootstrap: p99 5,220 ms across 30 samples in Actions run
// 36882163342. Twice that observation, rounded up to a second, is a hang guard,
// not a total startup budget: only an advancing kernel stage rearms it.
export const pythonStartupHangGuardMs = 11_000;

const stages = ["interpreter-launch", "stdlib-imports", "runtime-init", "host-init"] as const;
export type PythonStartupStage = (typeof stages)[number];

export class PythonKernelStartupError extends Error {
	readonly stage: PythonStartupStage;

	constructor(stage: PythonStartupStage, reason: string, cause?: Error) {
		super(`Python kernel startup failed at ${stage}: ${reason}`, { cause });
		this.name = "PythonKernelStartupError";
		this.stage = stage;
	}
}

/** Owns the ready event and a per-stage inactivity watchdog, never a total deadline. */
export class PythonStartup {
	readonly #timeoutMs: number;
	readonly #failureDetail: () => string;
	readonly #ready = Promise.withResolvers<void>();
	readonly ready = this.#ready.promise;
	#timer: NodeJS.Timeout | undefined;
	#stageIndex = 0;
	#settled = false;

	constructor(timeoutMs: number, failureDetail: () => string) {
		this.#timeoutMs = timeoutMs;
		this.#failureDetail = failureDetail;
		this.#arm();
	}

	progress(message: KernelToHostMessage): PythonStartupStage | undefined {
		if (this.#settled || message.type !== "status" || message.event.op !== "kernel-startup") return;
		const stage = stages.find((candidate) => candidate === message.event.stage);
		if (stage === undefined) return;
		const next = stages.indexOf(stage);
		if (next <= this.#stageIndex) return;
		this.#stageIndex = next;
		this.#arm();
		return stage;
	}

	settle(error?: Error): boolean {
		if (this.#settled) return false;
		this.#settled = true;
		clearTimeout(this.#timer);
		if (error) {
			const stage = stages[this.#stageIndex] ?? "interpreter-launch";
			this.#ready.reject(
				error instanceof PythonKernelStartupError
					? error
					: new PythonKernelStartupError(stage, error.message, error),
			);
		} else this.#ready.resolve();
		return true;
	}

	#arm(): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			const detail = this.#failureDetail().trim();
			this.settle(
				new PythonKernelStartupError(
					stages[this.#stageIndex] ?? "interpreter-launch",
					`no progress for ${this.#timeoutMs}ms${detail ? `; ${detail}` : ""}`,
				),
			);
		}, this.#timeoutMs);
	}
}
