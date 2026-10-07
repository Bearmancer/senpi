import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { MOVED_PATH_TOOL_CLASSES } from "../../src/core/extensions/builtin/moved-path-guard/tool-classes.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * code-yeongyu/senpi#2898: the guard is only as complete as its tool list. Every tool a full builtin load
 * registers must carry a moved-path class, so a new tool that writes files cannot ship unguarded by accident.
 */

describe("moved-path-guard tool classes (#2898)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("classifies every tool of a full builtin load", async () => {
		const harness = await createHarness({ extensionFactories: builtinExtensions.map((entry) => entry.factory) });
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		const registered = harness.session.getAllTools().map((tool) => tool.name);
		const unclassified = registered.filter((name) => !Object.hasOwn(MOVED_PATH_TOOL_CLASSES, name));

		expect(registered).toEqual(expect.arrayContaining(["write", "edit", "apply_patch", "bash", "bash_input"]));
		expect(unclassified).toEqual([]);
	});
});
