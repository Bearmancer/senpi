import { AsyncLocalStorage } from "node:async_hooks";

// Every continuation a cell creates (awaits, timers, I/O callbacks) runs inside its cell record. Stopping a cell
// releases it: everything it owns (timers, sleeps, requests, sockets, servers, views, workers) is cleared, rejected or
// closed, and anything its code tries to start afterwards is refused, while the kernel and its variables stay.
const cellRuns = new AsyncLocalStorage();
const releasedInterruptions = new WeakMap();
const MAX_CAUSE_DEPTH = 8;
const RESOURCE_CLOSERS = ["terminate", "destroy", "stop", "close", "end"];

// Some host bindings are read-only (Bun.fetch); those keep their own behaviour and are not owned by cells.
function replace(owner, name, replacement, patched) {
	const original = owner[name];
	try {
		owner[name] = replacement;
	} catch {
		return;
	}
	if (owner[name] !== replacement) return;
	patched.push(() => {
		owner[name] = original;
	});
}

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

export function onCellRelease(close) {
	const cell = cellRuns.getStore();
	return cell === undefined ? () => {} : onReleaseOf(cell, close);
}

function onReleaseOf(cell, close) {
	cell.onRelease ??= new Set();
	cell.onRelease.add(close);
	return () => cell.onRelease.delete(close);
}

export function releaseCell(cell) {
	cell.released = true;
	releasedInterruptions.set(cell.interruption, cell);
	for (const close of cell.onRelease ?? []) {
		try {
			close();
		} catch {}
	}
	cell.onRelease?.clear();
}

/**
 * The cell an unhandled rejection came from: a released cell whose interruption is the reason or sits in its `cause`
 * chain, or the cell whose async context the rejection runs in (Node exposes it to the handler; Bun does not).
 */
export function cellOfRejection(reason) {
	let current = reason;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		const cell = releasedInterruptions.get(current);
		if (cell !== undefined) return cell;
		current = current.cause;
	}
	return cellRuns.getStore();
}

function bindToCell(cell, promise) {
	return new Promise((resolve, reject) => {
		const forget = onReleaseOf(cell, () => reject(cell.interruption));
		promise.then(
			(value) => {
				forget();
				resolve(value);
			},
			(error) => {
				forget();
				reject(error);
			},
		);
	});
}

function closeResource(resource) {
	for (const method of RESOURCE_CLOSERS) {
		if (typeof resource?.[method] !== "function") continue;
		if (method === "stop") resource.stop(true);
		else resource[method]();
		return;
	}
}

function ownResultsOf(owner, name, patched) {
	const original = owner?.[name];
	if (typeof original !== "function") return;
	const own = function (...args) {
		const cell = cellRuns.getStore();
		if (cell === undefined) return original.apply(this, args);
		if (cell.released) throw cell.interruption;
		const result = original.apply(this, args);
		const register = (resource) => {
			onReleaseOf(cell, () => closeResource(resource));
			return resource;
		};
		return result instanceof Promise ? result.then(register) : register(result);
	};
	Object.assign(own, original);
	replace(owner, name, own, patched);
}

function patchTimers(scope, patched) {
	for (const [name, clearName] of [
		["setTimeout", "clearTimeout"],
		["setInterval", "clearInterval"],
		["setImmediate", "clearImmediate"],
	]) {
		const original = scope[name];
		const clear = scope[clearName];
		if (typeof original !== "function" || typeof clear !== "function") continue;
		const owned = function (callback, ...rest) {
			const cell = cellRuns.getStore();
			if (cell === undefined || typeof callback !== "function") return original.call(this, callback, ...rest);
			if (cell.released) {
				const never = original.call(this, () => {}, ...rest);
				clear.call(scope, never);
				return never;
			}
			let forget = () => {};
			const handle = original.call(
				this,
				function (...args) {
					if (name !== "setInterval") forget();
					return callback.apply(this, args);
				},
				...rest,
			);
			forget = onReleaseOf(cell, () => clear.call(scope, handle));
			return handle;
		};
		Object.assign(owned, original);
		replace(scope, name, owned, patched);
	}
}

function patchPromiseApi(owner, name, patched) {
	const original = owner?.[name];
	if (typeof original !== "function") return;
	const bound = function (...args) {
		const cell = cellRuns.getStore();
		if (cell === undefined) return original.apply(this, args);
		if (cell.released) return Promise.reject(cell.interruption);
		return bindToCell(cell, original.apply(this, args));
	};
	Object.assign(bound, original);
	replace(owner, name, bound, patched);
}

function patchTimerPromises(patched) {
	const timers = process.getBuiltinModule?.("node:timers/promises");
	if (timers === undefined) return;
	patchPromiseApi(timers, "setTimeout", patched);
	patchPromiseApi(timers, "setImmediate", patched);
	const original = timers.setInterval;
	if (typeof original !== "function") return;
	const owned = function (...args) {
		const cell = cellRuns.getStore();
		if (cell?.released) throw cell.interruption;
		const iterator = original.apply(this, args);
		if (cell === undefined) return iterator;
		onReleaseOf(cell, () => void iterator.return?.());
		return iterator;
	};
	replace(timers, "setInterval", owned, patched);
}

function patchFetch(scope, patched, name = "fetch") {
	const original = scope[name];
	if (typeof original !== "function") return;
	const owned = function (input, init) {
		const cell = cellRuns.getStore();
		if (cell === undefined) return original.call(this, input, init);
		if (cell.released) return Promise.reject(cell.interruption);
		const controller = new AbortController();
		const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const signal = own === undefined ? controller.signal : AbortSignal.any([own, controller.signal]);
		const forget = onReleaseOf(cell, () => controller.abort(cell.interruption));
		return original.call(this, input, { ...init, signal }).finally(forget);
	};
	Object.assign(owned, original);
	replace(scope, name, owned, patched);
}

// An operation already in flight when its cell is released rejects with the interruption at once, so the stopped
// cell's continuation never runs again; a non-promise result is returned as it is.
function settleWithCell(cell, result) {
	if (result === null || typeof result !== "object" || typeof result.then !== "function") return result;
	return new Promise((resolve, reject) => {
		const forget = onReleaseOf(cell, () => reject(cell.interruption));
		result.then(
			(value) => {
				forget();
				resolve(value);
			},
			(error) => {
				forget();
				reject(error);
			},
		);
	});
}

// A released cell's code may still be resumed by a short I/O completion; refusing new I/O at that point makes such a
// loop throw the interruption on its next operation instead of running on in the kept worker.
function refuseWhenReleased(owner, names, patched) {
	for (const name of names) {
		const original = owner?.[name];
		if (typeof original !== "function") continue;
		const guarded = function (...args) {
			const cell = cellRuns.getStore();
			if (cell?.released) throw cell.interruption;
			const result = original.apply(this, args);
			return cell === undefined ? result : settleWithCell(cell, result);
		};
		Object.assign(guarded, original);
		replace(owner, name, guarded, patched);
	}
}

const FS_PROMISE_OPERATIONS = [
	"readFile",
	"writeFile",
	"appendFile",
	"readdir",
	"stat",
	"lstat",
	"open",
	"access",
	"mkdir",
	"rm",
	"unlink",
	"rename",
	"copyFile",
];

function patchClass(scope, name, close, patched) {
	const Original = scope[name];
	if (typeof Original !== "function") return;
	const Owned = class extends Original {
		constructor(...args) {
			const cell = cellRuns.getStore();
			if (cell?.released) throw cell.interruption;
			super(...args);
			if (cell !== undefined) onReleaseOf(cell, () => close(this));
		}
	};
	Object.defineProperty(Owned, "name", { value: Original.name });
	replace(scope, name, Owned, patched);
}

const NODE_RESOURCE_FACTORIES = {
	"node:net": ["createConnection", "connect", "createServer"],
	"node:tls": ["connect", "createServer"],
	"node:http": ["request", "get", "createServer"],
	"node:https": ["request", "get", "createServer"],
	"node:dgram": ["createSocket"],
};

export function installCellOwnership(scope = globalThis) {
	const patched = [];
	patchTimers(scope, patched);
	patchTimerPromises(patched);
	patchFetch(scope, patched);
	patchClass(scope, "WebSocket", (socket) => socket.close(), patched);
	patchClass(scope, "Worker", (worker) => void worker.terminate(), patched);
	patchClass(process.getBuiltinModule?.("node:worker_threads") ?? {}, "Worker", (worker) => void worker.terminate(), patched);
	refuseWhenReleased(process.getBuiltinModule?.("node:fs/promises"), FS_PROMISE_OPERATIONS, patched);
	patchClass(scope, "MessageChannel", (channel) => {
		channel.port1.close();
		channel.port2.close();
	}, patched);
	patchClass(scope, "BroadcastChannel", (channel) => channel.close(), patched);
	const bun = scope.Bun;
	if (bun !== undefined) {
		patchPromiseApi(bun, "sleep", patched);
		if (bun.fetch !== scope.fetch) patchFetch(bun, patched, "fetch");
		refuseWhenReleased(bun, ["file", "write"], patched);
		for (const name of ["connect", "listen", "serve", "udpSocket"]) ownResultsOf(bun, name, patched);
	}
	for (const [module, factories] of Object.entries(NODE_RESOURCE_FACTORIES)) {
		const exports = process.getBuiltinModule?.(module);
		for (const name of factories) ownResultsOf(exports, name, patched);
	}
	// Node hands `import("node:…")` its own ESM namespace; without this sync a cell importing the module gets the
	// unowned originals.
	syncBuiltinExports();
	return () => {
		for (const undo of patched.reverse()) undo();
		syncBuiltinExports();
	};
}

function syncBuiltinExports() {
	process.getBuiltinModule?.("node:module")?.syncBuiltinESMExports?.();
}
