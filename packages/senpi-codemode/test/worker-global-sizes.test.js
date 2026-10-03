import { afterEach, describe, expect, it } from "vitest";
import { captureGlobalBaseline, largestGlobals } from "../src/kernels/js/worker-global-sizes.js";

const defined = [];

function defineGlobal(name, value) {
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
	defined.push(name);
}

afterEach(() => {
	for (const name of defined.splice(0)) Reflect.deleteProperty(globalThis, name);
});

describe("largest-globals sizing never runs user code", () => {
	it("Given a global array with an index accessor when the globals are sized then the getter never runs", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		const withAccessor = [];
		Object.defineProperty(withAccessor, 0, {
			get() {
				hits += 1;
				return 1;
			},
			enumerable: true,
		});
		defineGlobal("arrayWithAccessor", withAccessor);

		largestGlobals(baseline, 5);

		expect(hits).toBe(0);
	});

	it("Given an array hole whose prototype has an index getter when the globals are sized then the prototype getter never runs", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		class Holey extends Array {}
		Object.defineProperty(Holey.prototype, "1", {
			get() {
				hits += 1;
				return 1;
			},
		});
		const holey = new Holey();
		holey[0] = 1;
		holey[2] = 3;
		defineGlobal("holeyArray", holey);

		largestGlobals(baseline, 5);

		expect(hits).toBe(0);
	});

	it("Given a typed array subclass that overrides byteLength when the globals are sized then its real byte length is reported without running the override", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		class Counted extends Uint8Array {
			get byteLength() {
				hits += 1;
				return 0;
			}
		}
		defineGlobal("countedBytes", new Counted(2 * 1024 * 1024));

		const sized = largestGlobals(baseline, 5);

		expect(hits).toBe(0);
		expect(sized.find((global) => global.name === "countedBytes")?.bytes).toBeGreaterThanOrEqual(2 * 1024 * 1024);
	});

	it("Given a Map subclass that overrides size when the globals are sized then the override never runs", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		class Counted extends Map {
			get size() {
				hits += 1;
				return 0;
			}
		}
		const map = new Counted();
		for (let index = 0; index < 10; index += 1) map.set(index, "x".repeat(10));
		defineGlobal("countedMap", map);

		largestGlobals(baseline, 5);

		expect(hits).toBe(0);
	});

	it("Given a fully walked array with one accessor element when the globals are sized then it is still reported, marked approximate", () => {
		const baseline = captureGlobalBaseline();
		const texts = Array.from({ length: 500 }, () => "x".repeat(4096));
		Object.defineProperty(texts, 0, { get: () => "x", enumerable: true });
		defineGlobal("mostlyTexts", texts);

		const sized = largestGlobals(baseline, 5);

		expect(sized.find((global) => global.name === "mostlyTexts")).toMatchObject({ approximate: true });
	});
});
