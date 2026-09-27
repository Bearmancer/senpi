import { describe, expect, it } from "vitest";
import * as entry from "../src/index.ts";

describe("@code-yeongyu/senpi-desktop-service entry", () => {
	it("loads with an empty public surface while the package is a skeleton", () => {
		// Given: the package entry module, imported above.
		// When
		const exported = Object.keys(entry);

		// Then
		expect(exported).toEqual([]);
	});
});
