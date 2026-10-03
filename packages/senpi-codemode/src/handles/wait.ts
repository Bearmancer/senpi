import {
	EvalHandleError,
	type HandleOutcome,
	type HandlePhase,
	type HandleRef,
	type HandleSnapshot,
	type HandleWatch,
} from "@code-yeongyu/senpi";
import { refKey, type WaitRequest } from "./handle-args.ts";

export interface WaitBackend {
	watch(refs: readonly HandleRef[]): Promise<HandleWatch>;
	result(ref: HandleRef): Promise<HandleOutcome>;
	readonly signal?: AbortSignal;
}

export type WaitAnyResult = { readonly index: number; readonly ref: HandleRef; readonly value: unknown };

/** A handle's own failure, raised by `wait(..., {mode: "all"})` and `control.wait()`; `code` is in the text. */
export class HandleOutcomeError extends Error {
	readonly name = "HandleOutcomeError";
	readonly code: string;
	readonly ref: HandleRef;
	readonly details: unknown;

	constructor(outcome: Extract<HandleOutcome, { status: "rejected" }>) {
		super(`${outcome.error.code}: ${outcome.error.message}`);
		this.code = outcome.error.code;
		this.ref = outcome.ref;
		this.details = outcome.error.details;
	}
}

export class WaitAllRejectedError extends Error {
	readonly name = "WaitAllRejectedError";
	readonly code = "eval_wait_all_rejected";
	readonly outcomes: readonly HandleOutcome[];

	constructor(outcomes: readonly HandleOutcome[]) {
		const summary = outcomes
			.map((outcome) =>
				outcome.status === "rejected" ? `${outcome.ref.id}: ${outcome.error.code}` : outcome.ref.id,
			)
			.join("; ");
		super(`eval_wait_all_rejected: wait(any) found no successful handle among ${outcomes.length}; ${summary}`);
		this.outcomes = outcomes;
	}
}

const TERMINAL: ReadonlySet<HandlePhase> = new Set(["succeeded", "failed", "cancelled", "lost"]);

/**
 * The in-cell barrier. Subscribes once per distinct ref, keeps duplicate slots, settles according to the
 * mode, and never cancels work: a timeout only closes the subscription. Parked time is the caller's
 * concern (the bridge-call path pauses the run budget around this call).
 */
export async function waitForHandles(request: WaitRequest, backend: WaitBackend): Promise<unknown> {
	const { refs, mode } = request;
	if (refs.length === 0) {
		if (mode === "any") throw new EvalHandleError("eval_wait_empty", "wait(any) needs at least one handle");
		return [];
	}
	const unique = [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
	const outcomes = new Map<string, HandleOutcome>();
	const revisions = new Map<string, number>();
	const watch = await backend.watch(unique);
	const finish = (): unknown => {
		switch (mode) {
			case "all":
				return refs.map((ref) => settledValue(outcomes, ref));
			case "settled":
				return refs.map((ref) => outcomeOf(outcomes, ref));
			case "any":
				return firstSuccess(refs, outcomes) ?? rejectAll(refs, outcomes);
			default:
				return assertNever(mode);
		}
	};
	// Returns true once the mode can settle without waiting for the remaining handles.
	const absorb = async (snapshot: HandleSnapshot): Promise<boolean> => {
		const key = refKey(snapshot.ref);
		const known = revisions.get(key);
		if (known !== undefined && snapshot.revision <= known) return false;
		revisions.set(key, snapshot.revision);
		if (snapshot.ref.kind === "workpool" && snapshot.phase === "pending" && snapshot.host_status === "open") {
			throw new EvalHandleError(
				"eval_pool_open",
				`workpool ${snapshot.ref.id} is still open; close() it before waiting`,
			);
		}
		if (!TERMINAL.has(snapshot.phase) || outcomes.has(key)) return false;
		const outcome = await backend.result(snapshot.ref);
		outcomes.set(key, outcome);
		if (mode === "all" && outcome.status === "rejected") throw new HandleOutcomeError(outcome);
		if (mode === "any" && outcome.status === "fulfilled") return true;
		return outcomes.size === unique.length;
	};
	try {
		for (const snapshot of watch.initial) {
			if (await absorb(snapshot)) return finish();
		}
		if (outcomes.size === unique.length) return finish();
		if (request.timeoutSeconds === 0) throw timeoutError(request.timeoutSeconds, refs, outcomes);
		for await (const snapshot of bounded(watch, request.timeoutSeconds, backend.signal, refs, outcomes)) {
			if (await absorb(snapshot)) return finish();
		}
		return finish();
	} finally {
		watch.close();
	}
}

/** Pulls updates until the watch ends, the wait deadline passes, or the cell's signal aborts. */
async function* bounded(
	watch: HandleWatch,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
	refs: readonly HandleRef[],
	outcomes: ReadonlyMap<string, HandleOutcome>,
): AsyncGenerator<HandleSnapshot> {
	const iterator = watch.updates[Symbol.asyncIterator]();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const interruption = new Promise<never>((_resolve, reject) => {
		if (timeoutSeconds !== undefined) {
			timer = setTimeout(() => reject(timeoutError(timeoutSeconds, refs, outcomes)), timeoutSeconds * 1_000);
		}
		if (signal !== undefined) {
			onAbort = () =>
				reject(signal.reason instanceof Error ? signal.reason : new Error("wait() cancelled with its cell"));
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	// Never left unhandled: the race below always observes it while the loop runs.
	interruption.catch(() => undefined);
	try {
		while (true) {
			const step = await Promise.race([iterator.next(), interruption]);
			if (step.done) return;
			yield step.value;
		}
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
		await iterator.return?.();
	}
}

function timeoutError(seconds: number, refs: readonly HandleRef[], outcomes: ReadonlyMap<string, HandleOutcome>) {
	const settled = refs.filter((ref) => outcomes.has(refKey(ref))).length;
	return new EvalHandleError(
		"eval_wait_timeout",
		`wait() timed out after ${seconds}s; ${settled}/${refs.length} handles settled; work was not cancelled`,
	);
}

function outcomeOf(outcomes: ReadonlyMap<string, HandleOutcome>, ref: HandleRef): HandleOutcome {
	const outcome = outcomes.get(refKey(ref));
	if (outcome === undefined) throw new EvalHandleError("eval_handle_pending", `${ref.id} did not settle`);
	return outcome;
}

function settledValue(outcomes: ReadonlyMap<string, HandleOutcome>, ref: HandleRef): unknown {
	const outcome = outcomeOf(outcomes, ref);
	if (outcome.status === "rejected") throw new HandleOutcomeError(outcome);
	return outcome.value;
}

function firstSuccess(refs: readonly HandleRef[], outcomes: ReadonlyMap<string, HandleOutcome>) {
	for (const [index, ref] of refs.entries()) {
		const outcome = outcomes.get(refKey(ref));
		if (outcome?.status === "fulfilled") return { index, ref, value: outcome.value } satisfies WaitAnyResult;
	}
	return undefined;
}

function rejectAll(refs: readonly HandleRef[], outcomes: ReadonlyMap<string, HandleOutcome>): never {
	throw new WaitAllRejectedError(refs.map((ref) => outcomeOf(outcomes, ref)));
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported wait mode: ${String(value)}`);
}
