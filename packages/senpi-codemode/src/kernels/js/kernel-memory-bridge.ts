import type { KernelMemoryThresholds } from "../../bridge/memory-protocol.ts";
import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { MEMORY_COLLECTED_OP } from "../../bridge/reserved.ts";
import { KernelMemoryPolicy } from "../shared/kernel-memory.ts";
import type { ResultMessage } from "./kernel-contract.ts";

export interface JavaScriptMemoryReading {
	readonly liveBytes: number;
	readonly measure: "heap";
}

type QueryResult = Extract<KernelToHostMessage, { type: "memory-query-result" }>;

/**
 * The host half of one JS kernel's memory: the post-cell policy (notice, ceiling, recycle), the last
 * heap reading the worker sent (result frames, idle collections, queries), and the on-demand queries
 * still waiting for the worker. Losing the worker forgets the reading and rejects every waiting query.
 */
export class KernelMemoryBridge {
	readonly #policy: KernelMemoryPolicy | null;
	readonly #onCollected: ((liveBytes: number) => void) | undefined;
	readonly #queries = new Map<string, PromiseWithResolvers<JavaScriptMemoryReading>>();
	#lastLiveBytes: number | undefined;

	constructor(thresholds: KernelMemoryThresholds | undefined, onCollected?: (liveBytes: number) => void) {
		this.#policy = thresholds === undefined ? null : new KernelMemoryPolicy("js", thresholds);
		this.#onCollected = onCollected;
	}

	get lastLiveBytes(): number | undefined {
		return this.#lastLiveBytes;
	}

	/** Consumes the worker's memory messages (idle collections, query results); false for anything else. */
	consume(message: KernelToHostMessage): boolean {
		if (message.type === "memory-query-result") {
			this.#answered(message);
			return true;
		}
		if (message.type !== "status" || message.event.op !== MEMORY_COLLECTED_OP) return false;
		const liveBytes = message.event.liveBytes;
		if (typeof liveBytes !== "number") return true;
		this.#lastLiveBytes = liveBytes;
		this.#policy?.observeLive(liveBytes);
		this.#onCollected?.(liveBytes);
		return true;
	}

	settled(message: ResultMessage): ResultMessage {
		if (message.memory === undefined) return message;
		this.#lastLiveBytes = message.memory.liveBytes;
		if (this.#policy === null) return message;
		return { ...message, memory: this.#policy.annotate(message.memory) };
	}

	/** True when an over-ceiling kernel must restart now: it is `idle` (nothing running or queued). */
	claimRecycle(idle: boolean): boolean {
		if (!idle || this.#policy?.recyclePending !== true) return false;
		this.#policy.recycleStarted();
		return true;
	}

	query(post: (message: HostToKernelMessage) => void): Promise<JavaScriptMemoryReading> {
		const requestId = crypto.randomUUID();
		const pending = Promise.withResolvers<JavaScriptMemoryReading>();
		this.#queries.set(requestId, pending);
		post({ type: "memory-query", requestId });
		return pending.promise;
	}

	/** The worker is gone (reset, crash, stop, recycle): its memory and its unanswered queries went with it. */
	workerLost(error: Error): void {
		this.#policy?.kernelRetired();
		this.#lastLiveBytes = undefined;
		const waiting = [...this.#queries.values()];
		this.#queries.clear();
		for (const pending of waiting) pending.reject(error);
	}

	#answered(result: QueryResult): void {
		const pending = this.#queries.get(result.requestId);
		if (pending === undefined) return;
		this.#queries.delete(result.requestId);
		this.#lastLiveBytes = result.liveBytes;
		pending.resolve({ liveBytes: result.liveBytes, measure: result.measure });
	}
}
