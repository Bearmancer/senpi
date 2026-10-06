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
