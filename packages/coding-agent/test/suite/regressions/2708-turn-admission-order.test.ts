import { describe, expect, it } from "vitest";

import {
	trackTurnAdmission,
	type TurnAdmissionDisposition,
	type TurnAdmissionEvent,
} from "../../../src/core/continue-from-leaf.ts";

// The real AgentSession's loop always emits agent_start after the disposition
// microtask, so only this mechanism-level test can force the inverted order.

function singleFlagWait(input: {
	disposition: Promise<TurnAdmissionDisposition>;
	subscribe: (listener: (event: TurnAdmissionEvent) => void) => () => void;
}): Promise<void> {
	let resolveStarted: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	let turnStarted = false;
	void input.disposition.then((disposition) => {
		if (disposition === "delegated") resolveStarted?.();
		else if (disposition === "started") turnStarted = true;
	});
	input.subscribe((event) => {
		if (event.type === "agent_start" && turnStarted) resolveStarted?.();
	});
	return promise;
}

function driver(): {
	disposition: Promise<TurnAdmissionDisposition>;
	resolveDisposition: (d: TurnAdmissionDisposition) => void;
	subscribe: (listener: (event: TurnAdmissionEvent) => void) => () => void;
	emit: (event: TurnAdmissionEvent) => void;
} {
	const listeners = new Set<(event: TurnAdmissionEvent) => void>();
	let resolveD: ((d: TurnAdmissionDisposition) => void) | undefined;
	const disposition = new Promise<TurnAdmissionDisposition>((resolve) => {
		resolveD = resolve;
	});
	return {
		disposition,
		resolveDisposition: (d) => resolveD?.(d),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
	};
}

async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
	return Promise.race([
		promise.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
	]);
}

describe("trackTurnAdmission (senpi #2708)", () => {
	it("resolves when agent_start precedes the started disposition (single-flag logic misses it)", async () => {
		const withSingleFlag = driver();
		withSingleFlag.emit({ type: "agent_start" });
		withSingleFlag.resolveDisposition("started");
		expect(await settlesWithin(singleFlagWait(withSingleFlag), 150)).toBe(false);

		const withPair = driver();
		const tracked = trackTurnAdmission(withPair);
		withPair.emit({ type: "agent_start" });
		withPair.resolveDisposition("started");
		expect(await settlesWithin(tracked.promise, 150)).toBe(true);
		tracked.dispose();
	});

	it("resolves when the started disposition precedes agent_start", async () => {
		const withPair = driver();
		const tracked = trackTurnAdmission(withPair);
		withPair.resolveDisposition("started");
		await Promise.resolve();
		withPair.emit({ type: "agent_start" });
		expect(await settlesWithin(tracked.promise, 150)).toBe(true);
		tracked.dispose();
	});

	it("resolves immediately on a delegated queue, with no agent_start", async () => {
		const withPair = driver();
		const tracked = trackTurnAdmission(withPair);
		withPair.resolveDisposition("delegated");
		expect(await settlesWithin(tracked.promise, 150)).toBe(true);
		tracked.dispose();
	});
});
