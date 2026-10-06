import { AsyncLocalStorage } from "node:async_hooks";

// Every continuation a cell creates (awaits, timers, spawned-process callbacks) runs inside its cell record, so
// work that outlives a stopped cell can be recognised as the stopped cell's and refused, instead of acting on
// behalf of whichever cell runs next.
const cellRuns = new AsyncLocalStorage();

export function runInCell(cell, run) {
	return cellRuns.run(cell, run);
}

export function releasedCellError() {
	const cell = cellRuns.getStore();
	return cell?.released === true ? cell.interruption : undefined;
}

export function assertCellLive() {
	const error = releasedCellError();
	if (error !== undefined) throw error;
}

// A cell's fetches carry its abort signal: releasing the cell aborts the ones in flight, and a released cell starts none.
export function installReleasedCellFetchGuard(scope = globalThis) {
	const original = scope.fetch;
	if (typeof original !== "function") return () => {};
	const guarded = function (input, init) {
		const cell = cellRuns.getStore();
		if (cell === undefined) return original.call(this, input, init);
		if (cell.released) return Promise.reject(cell.interruption);
		const controller = new AbortController();
		const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const signal = own === undefined ? controller.signal : AbortSignal.any([own, controller.signal]);
		cell.fetches ??= new Set();
		cell.fetches.add(controller);
		return original.call(this, input, { ...init, signal }).finally(() => cell.fetches.delete(controller));
	};
	Object.assign(guarded, original);
	scope.fetch = guarded;
	return () => {
		scope.fetch = original;
	};
}

export function abortCellFetches(cell) {
	for (const controller of cell.fetches ?? []) controller.abort(cell.interruption);
}

// A released cell's timer callbacks are dropped, so a polling loop parks on its next tick instead of running on.
export function installReleasedCellTimerGuard(scope = globalThis) {
	const originals = { setTimeout: scope.setTimeout, setInterval: scope.setInterval, setImmediate: scope.setImmediate };
	for (const [name, original] of Object.entries(originals)) {
		if (typeof original !== "function") continue;
		const guarded = function (callback, ...rest) {
			if (typeof callback !== "function") return original.call(this, callback, ...rest);
			return original.call(
				this,
				function (...args) {
					if (releasedCellError() !== undefined) return undefined;
					return callback.apply(this, args);
				},
				...rest,
			);
		};
		Object.assign(guarded, original);
		scope[name] = guarded;
	}
	return () => Object.assign(scope, originals);
}
