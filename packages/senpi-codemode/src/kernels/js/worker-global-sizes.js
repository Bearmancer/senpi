import { types } from "node:util";

const SAMPLED_ELEMENTS = 1_000;
const NODE_BUDGET = 200_000;
const MAX_DEPTH = 64;
const POINTER_BYTES = 8;
const OBJECT_BYTES = 16;
const FUNCTION_BYTES = 64;
const INTERNAL_GLOBAL_PREFIX = "__senpi";
const MIN_REPORTED_BYTES = 1024 * 1024;

export function captureGlobalBaseline() {
	return new Set(Object.getOwnPropertyNames(globalThis));
}

/**
 * Estimated retained size of each user global, largest first. Collections are sized from their length and
 * a sample of up to 1,000 evenly spaced elements, so a huge array is not under-reported; a shared visited
 * set counts shared objects once, and one node budget bounds the whole walk. A sampled or cut-short
 * estimate is marked `approximate`. Accessors and proxies are never invoked.
 */
export function largestGlobals(baseline, limit) {
	const sizer = createSizer();
	const sized = [];
	for (const name of Object.getOwnPropertyNames(globalThis)) {
		if (baseline.has(name) || name.startsWith(INTERNAL_GLOBAL_PREFIX)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
		if (descriptor === undefined || !("value" in descriptor)) continue;
		const measured = sizer.measure(descriptor.value);
		if (measured === undefined) continue;
		const { bytes, approximate } = measured;
		sized.push({ name, bytes: Math.round(bytes), ...(approximate ? { approximate: true } : {}) });
	}
	return sized
		.filter((global) => global.bytes >= MIN_REPORTED_BYTES)
		.sort((left, right) => right.bytes - left.bytes)
		.slice(0, limit);
}

function createSizer() {
	const seen = new WeakSet();
	let nodes = 0;
	let approximate = false;

	function sampled(length, at, depth) {
		if (length <= SAMPLED_ELEMENTS) {
			let total = 0;
			for (let index = 0; index < length; index += 1) total += size(at(index), depth);
			return total;
		}
		approximate = true;
		const step = length / SAMPLED_ELEMENTS;
		let total = 0;
		for (let sample = 0; sample < SAMPLED_ELEMENTS; sample += 1) total += size(at(Math.floor(sample * step)), depth);
		return (total / SAMPLED_ELEMENTS) * length;
	}

	function entriesOf(iterable, count, depth, sizeOf) {
		const taken = [];
		for (const entry of iterable) {
			taken.push(entry);
			if (taken.length >= SAMPLED_ELEMENTS) break;
		}
		if (taken.length < count) approximate = true;
		let total = 0;
		for (const entry of taken) total += sizeOf(entry, depth);
		return total * (count / Math.max(1, taken.length));
	}

	function objectSize(value, depth) {
		if (types.isProxy(value)) return OBJECT_BYTES;
		if (ArrayBuffer.isView(value)) return value.byteLength;
		if (types.isAnyArrayBuffer(value)) return value.byteLength;
		if (typeof Blob === "function" && value instanceof Blob) return value.size;
		if (Array.isArray(value)) return OBJECT_BYTES + value.length * POINTER_BYTES + sampled(value.length, (index) => value[index], depth);
		if (value instanceof Map) {
			const entries = Map.prototype.entries.call(value);
			return OBJECT_BYTES + value.size * 2 * POINTER_BYTES + entriesOf(entries, value.size, depth, ([key, item], at) => size(key, at) + size(item, at));
		}
		if (value instanceof Set) return OBJECT_BYTES + value.size * POINTER_BYTES + entriesOf(Set.prototype.values.call(value), value.size, depth, size);
		const keys = Object.keys(value);
		const propertyValue = (index) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
			return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
		};
		return OBJECT_BYTES + keys.length * POINTER_BYTES + sampled(keys.length, propertyValue, depth);
	}

	// Bytes a value owns beyond the pointer-sized slot its container already charged for it.
	function size(value, depth) {
		switch (typeof value) {
			case "string":
				return OBJECT_BYTES + value.length * 2;
			case "function":
				return FUNCTION_BYTES;
			case "object":
				break;
			default:
				return 0;
		}
		if (value === null || seen.has(value)) return 0;
		if (depth >= MAX_DEPTH || nodes >= NODE_BUDGET) {
			approximate = true;
			return 0;
		}
		seen.add(value);
		nodes += 1;
		return objectSize(value, depth + 1);
	}

	return {
		measure(value) {
			approximate = false;
			try {
				return { bytes: POINTER_BYTES + size(value, 0), approximate };
			} catch (error) {
				// A user value can still throw from an exotic element read (an index getter); it is left unsized.
				if (error instanceof Error) return undefined;
				throw error;
			}
		},
	};
}
