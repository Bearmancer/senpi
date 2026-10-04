// allow: SIZE_OK — one persistent JavaScript lifecycle state machine owns the queue, the worker slot, host entries and recovery.
import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { CHILD_LIFECYCLE_OP, INTERRUPT_ACK_OP } from "../../bridge/reserved.ts";
import type { HostCellExecutor, KernelInterruptHandle } from "../../tool/types.ts";
import { inputAtStart } from "../shared/cell-source-at-start.ts";
import { restartNotice } from "../shared/kernel-death.ts";
import { KernelToolHostPump } from "../shared/kernel-tools-pump.ts";
import { ActiveCellControl } from "./active-cell-control.ts";
import { HostEntries, refusedEntry } from "./host-entries.ts";
import { DEFAULT_INTERRUPT_BOUNDS, JS_INTERRUPT_GRACE_MS, type WorkerRetirement } from "./interrupt-bounds.ts";
import {
	assertJavaScriptKernelOpen,
	type JavaScriptKernelMode,
	type JavaScriptRunInput,
	type LifecycleState,
	type ResultMessage,
	resolveKernelToolNameSource,
	type ToolCallMessage,
} from "./kernel-contract.ts";
import { type JavaScriptMemoryReading, KernelMemoryBridge } from "./kernel-memory-bridge.ts";
import { kernelToolError } from "./kernel-tools-errors.ts";
import type {
	KernelToolsDescribeResult,
	KernelToolsInvokeOptions,
	KernelToolsInvokeRequest,
} from "./kernel-tools-types.ts";
import { type JavaScriptKernelOptions, LocalModuleLoader } from "./local-module-loader.ts";
import { JavaScriptProcessMemoryHost } from "./process-memory-host.ts";
import { JavaScriptRunQueue, type PendingJavaScriptRun } from "./run-queue.ts";
import { ToolCallQueue } from "./tool-call-queue.ts";
import { WorkerChildren } from "./worker-children.ts";
import { crashedResult } from "./worker-host.ts";
import { WorkerRecovery } from "./worker-recovery.ts";
import { WorkerSlot } from "./worker-slot.ts";

export { JavaScriptKernelClosedError, type JavaScriptKernelMode, type JavaScriptRunInput } from "./kernel-contract.ts";
export type { JavaScriptMemoryReading } from "./kernel-memory-bridge.ts";
export type { JavaScriptKernelOptions } from "./local-module-loader.ts";
export { type JavaScriptWorkerEntryUrlOptions, resolveJsWorkerEntryUrl } from "./worker-startup.ts";

export class JavaScriptKernel {
	readonly #hostEntries = new HostEntries<PendingJavaScriptRun>();
	readonly #options: JavaScriptKernelOptions;
	readonly #moduleLoader: LocalModuleLoader;
	readonly #slot: WorkerSlot;
	#lifecycle: LifecycleState = "open";
	#activation: Promise<void> | null = null;
	#closePromise: Promise<void> | null = null;
	readonly #runs = new JavaScriptRunQueue();
	readonly #kernelTools = new KernelToolHostPump(
		(message) => this.#slot.postMessage(message),
		() => this.#lifecycle === "open" && this.#slot.present,
	);
	readonly #toolCalls = new ToolCallQueue();
	readonly #children: WorkerChildren;
	readonly #memory: KernelMemoryBridge;
	readonly #processMemory: JavaScriptProcessMemoryHost | null;
	#processRestartNotice: string | null = null;
	readonly #activeCell: ActiveCellControl;
	readonly #recovery = new WorkerRecovery({
		runs: this.#runs,
		isOpen: () => this.#lifecycle === "open",
		ensureReady: () => this.#ensureReady(),
		startNext: () => this.#startNext(),
	});

	constructor(options: JavaScriptKernelOptions) {
		this.#options = options;
		this.#activeCell = new ActiveCellControl({
			runs: this.#runs,
			bounds: options.interruptBounds ?? DEFAULT_INTERRUPT_BOUNDS,
			post: (message) => this.#slot.postMessage(message),
			terminate: () => this.#terminate(),
			recover: () => void this.#recovery.recover(() => Promise.resolve()),
			clearToolCalls: () => this.#toolCalls.clear(),
		});
		this.#memory = new KernelMemoryBridge(
			options.isolation === "process" ? undefined : options.memory,
			options.onMemoryCollected,
		);
		this.#processMemory =
			options.isolation === "process" && options.processMemory !== undefined
				? new JavaScriptProcessMemoryHost(options.processMemory.thresholds, options.processMemory.readFootprint)
				: null;
		this.#processRestartNotice = null;
		this.#children = new WorkerChildren(options.collectOrphanedChildren);
		this.#moduleLoader = new LocalModuleLoader(options);
		this.#slot = new WorkerSlot(options, {
			isOpen: () => this.#lifecycle === "open",
			onMessage: (message) => this.#handleMessage(message),
			onCrash: (error) => this.#handleCrash(error),
		});
	}

	get mode(): JavaScriptKernelMode {
		return this.#slot.mode;
	}

	/** The last heap reading the worker sent (a result, an idle collection, a query); none before the first. */
	get processPid(): number | undefined {
		return this.#slot.processPid;
	}

	get lastLiveBytes(): number | undefined {
		if (this.#processMemory !== null) return this.#processMemory.lastLiveBytes(() => this.#slot.processPid);
		return this.#memory.lastLiveBytes;
	}

	/** A heap reading taken between cells without running one; nothing when no worker is live to ask. */
	async queryMemory(): Promise<JavaScriptMemoryReading | undefined> {
		if (this.#processMemory !== null) return this.#processMemory.query(() => this.#slot.processPid);
		if (this.#lifecycle !== "open" || !this.#slot.present || this.#slot.startingUp) return undefined;
		return await this.#memory.query((message) => this.#slot.postMessage(message));
	}

	get kernelToolEvents(): EventTarget {
		return this.#kernelTools.events;
	}

	describeKernelTools(names: readonly string[]): Promise<KernelToolsDescribeResult> {
		return this.#kernelTools.describe(names);
	}

	invokeKernelTool(
		request: KernelToolsInvokeRequest,
		options?: AbortSignal | KernelToolsInvokeOptions,
	): Promise<unknown> {
		return this.#kernelTools.invoke(request, options);
	}

	async run(input: JavaScriptRunInput): Promise<ResultMessage> {
		assertJavaScriptKernelOpen(this.#lifecycle, "run");
		const promise = this.#runs.enqueue(input);
		this.#activate();
		return await promise;
	}

	cancelQueued(cellId: string, reason: string): boolean {
		return this.#runs.remove(cellId, reason);
	}

	queueSnapshot(): { activeCellId: string | null; queuedCellIds: readonly string[] } {
		return this.#runs.snapshot();
	}

	async interrupt(reason = "interrupted", cellId?: string): Promise<KernelInterruptHandle> {
		assertJavaScriptKernelOpen(this.#lifecycle, "interrupt");
		const active = this.#runs.active;
		if (cellId !== undefined && active?.input.cellId !== cellId) {
			const cancelled = this.cancelQueued(cellId, reason);
			return { stateRetained: Promise.resolve(true), ...(cancelled ? {} : { note: "cell not found" }) };
		}
		if (active && this.#hostEntries.abort(active, reason)) return { stateRetained: Promise.resolve(true) };
		if (!active) {
			// A worker still stuck in startup is not a healthy idle worker: retiring it is the only recovery.
			const wedgedInStartup = this.#slot.startingUp;
			this.#runs.settleAll(`JS cell interrupted: ${reason}`);
			if (!wedgedInStartup) return { stateRetained: Promise.resolve(true) };
			await this.#restartAfterStop();
			return { stateRetained: Promise.resolve(false) };
		}
		this.#activeCell.disarm();
		const stop = await this.#activeCell.stop(active, reason, `JS cell interrupted: ${reason}`);
		return { stateRetained: Promise.resolve(stop.retained), ...(stop.note === undefined ? {} : { note: stop.note }) };
	}

	async reset(): Promise<void> {
		assertJavaScriptKernelOpen(this.#lifecycle, "reset");
		await this.#terminate();
		this.#toolCalls.clear();
		assertJavaScriptKernelOpen(this.#lifecycle, "reset");
		await this.#ensureReady();
		this.#startNext();
	}

	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void {
		if (this.#lifecycle === "open") this.#slot.postMessage(message);
	}

	async nextToolCall(): Promise<ToolCallMessage> {
		return await this.#toolCalls.next();
	}

	async close(): Promise<void> {
		if (this.#closePromise) return await this.#closePromise;
		this.#slot.postMessage({ type: "close" });
		this.#lifecycle = "closing";
		const hostEntriesStopped = this.#hostEntries.stopAll(
			"JS kernel closed",
			this.#options.interruptBounds?.graceMs ?? JS_INTERRUPT_GRACE_MS,
		);
		this.#runs.settleAll("JS kernel closed");
		this.#kernelTools.rejectAll(kernelToolError("kernel_tool_stale", "JS kernel closed"));
		this.#toolCalls.clear();
		const recovery = this.#recovery.inFlight;
		const closePromise = (async () => {
			await hostEntriesStopped;
			if (recovery) await recovery;
			await this.#terminate();
		})().finally(() => {
			this.#lifecycle = "closed";
		});
		this.#closePromise = closePromise;
		return await closePromise;
	}

	#activate(): void {
		if (this.#activation || this.#lifecycle !== "open" || this.#runs.active || !this.#runs.hasWaiting) return;
		const activation = this.#recovery.bringUp();
		this.#activation = activation;
		void activation.then(() => {
			if (this.#activation === activation) this.#activation = null;
			if (this.#lifecycle === "open" && !this.#runs.active && this.#runs.hasWaiting) this.#activate();
		});
	}

	async #ensureReady(): Promise<void> {
		assertJavaScriptKernelOpen(this.#lifecycle, "run");
		try {
			await this.#slot.ensureReady();
		} catch (error) {
			if (this.#options.isolation !== "process") throw error;
			// Process mode reports a failed start on the waiting cell, never as a rejection of run().
			if (this.#lifecycle === "open") this.#runs.settleAll(error instanceof Error ? error.message : String(error));
		}
	}

	#startNext(): void {
		if (this.#lifecycle !== "open" || this.#runs.active || !this.#slot.present) return;
		const next = this.#runs.startNext(performance.now());
		if (!next) return;
		const input = inputAtStart(next.input);
		if ("refused" in input) {
			this.#runHostEntry(next, refusedEntry(input.refused));
			return;
		}
		if (input.host !== undefined) {
			this.#runHostEntry(next, input.host);
			return;
		}
		this.#activeCell.arm(next);
		this.#slot.postMessage({
			type: "kernel-tools-names",
			hostToolNames: resolveKernelToolNameSource(this.#options.hostToolNames),
			foreignLanguageNames: resolveKernelToolNameSource(this.#options.foreignLanguageNames),
		});
		this.#slot.postMessage({
			type: "run",
			cellId: next.input.cellId,
			code: this.#moduleLoader.prepareCell(
				input.code,
				input.kernelPreludes,
				input.sourceFile,
				input.packageRoot?.(),
			),
			timeoutMs: next.input.timeoutMs,
		});
	}

	async #restartAfterStop(): Promise<void> {
		await this.#recovery.recover(() => this.#terminate());
	}

	#handleMessage(message: KernelToHostMessage): void {
		if (this.#kernelTools.consume(message) && message.type !== "tool-call") return;
		if (this.#memory.consume(message)) return;
		if (message.type === "status" && message.event.op === INTERRUPT_ACK_OP) {
			this.#runs.acknowledgeInterrupt(message.event);
			return;
		}
		if (message.type === "status" && message.event.op === CHILD_LIFECYCLE_OP) {
			this.#children.track(message.event);
			return;
		}
		(this.#runs.active?.input.onMessage ?? this.#options.onMessage)?.(message);
		if (message.type === "tool-call") {
			this.#toolCalls.push(message);
			return;
		}
		if (message.type !== "result") return;
		const active = this.#runs.active;
		if (!active || active.input.cellId !== message.cellId) return;
		this.#activeCell.disarm();
		this.#runs.releaseActive(active);
		active.settledByWorker = true;
		let settled =
			this.#processMemory === null
				? this.#memory.settled(message)
				: this.#processMemory.settled(message, () => this.#slot.processPid);
		if (this.#processRestartNotice !== null && this.#processMemory === null) {
			const notice = this.#processRestartNotice;
			this.#processRestartNotice = null;
			settled = { ...settled, notice, kernelState: "restarted" };
		}
		this.#runs.settle(active, active.interruptResult ?? settled);
		this.#startNext();
		// A kernel over its memory ceiling restarts only once no cell is running or queued on it.
		if (this.#memory.claimRecycle(!this.#runs.active && !this.#runs.hasWaiting)) void this.#restartAfterStop();
		if (this.#processMemory?.claimRecycle(!this.#runs.active && !this.#runs.hasWaiting) === true)
			void this.#restartAfterStop();
	}

	// A host-executed entry (an install magic) holds the queue slot like a cell but never reaches the worker,
	// so a cancel aborts the host work and the worker's state is untouched.
	#runHostEntry(run: PendingJavaScriptRun, host: HostCellExecutor): void {
		this.#hostEntries.start(run, run.input.cellId, host, {
			emit: (message) => (run.input.onMessage ?? this.#options.onMessage)?.(message),
			settle: (result) => {
				if (!this.#runs.releaseActive(run)) return;
				this.#runs.settle(run, result);
				this.#startNext();
			},
			durationMs: () => this.#runs.durationMs(run, performance.now()),
			settleAfterAbort: true,
		});
	}

	#handleCrash(error: Error): void {
		const active = this.#runs.active;
		if (!active && this.#slot.startingUp) return;
		this.#activeCell.disarm();
		this.#kernelTools.rejectAll(kernelToolError("kernel_tool_stale", error.message));
		this.#memory.workerLost(error);
		this.#processMemory?.workerLost();
		if (active) {
			this.#runs.releaseActive(active);
			this.#runs.settle(
				active,
				crashedResult(active.input.cellId, error, this.#runs.durationMs(active, performance.now())),
			);
		}
		this.#toolCalls.clear();
		if (this.#processMemory === null) {
			this.#processRestartNotice = restartNotice("js", error.message);
		} else {
			this.#processMemory.markRestarted(error);
		}
		void this.#restartAfterStop();
	}

	/** Retire the worker, then whatever cell children it still owned. */
	async #terminate(): Promise<WorkerRetirement> {
		this.#activeCell.disarm();
		this.#kernelTools.rejectAll(kernelToolError("kernel_tool_stale", "JavaScript worker reset"));
		this.#memory.workerLost(new Error("JavaScript worker reset"));
		const retirement = await this.#slot.retire();
		await this.#children.retire();
		return retirement;
	}
}
