import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createBashTool } from "../../../src/core/tools/bash.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function headless(flags: ReadonlyArray<readonly [string, string]>, command: string) {
	const harness = await createHarness({
		tools: [createBashTool(process.cwd())],
		extensionFactories: [permissionSystemExtension],
		extensionFlagValues: new Map(flags),
	});
	harnesses.push(harness);
	writeFileSync(join(harness.tempDir, "notes.txt"), "keep me\n");
	await harness.session.bindExtensions({});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: `cd ${harness.tempDir} && ${command}` }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("continued"),
	]);
	await harness.session.prompt("tidy up");
	return { harness, result: getMessageText(getToolResult(harness, "bash")) };
}

describe("auto permission preset with no UI to ask (print mode, unbound SDK)", () => {
	it.each([
		["with no rule of the user's", []],
		["with --permission bash=allow", [["permission", "bash=allow"]]],
	] as const)(
		"refuses what auto asks for %s, and the turn goes on",
		async (_label, extra) => {
			// Given an auto session with no approver, optionally with a user allow for every command.
			// When the agent deletes a file, which auto asks for.
			const { harness, result } = await headless([["permission-preset", "auto"], ...extra], "rm notes.txt");
			// Then the call is refused at once with a reason, the file stays, and the turn continues.
			expect(result).toContain("Permission required for bash");
			expect(result).not.toContain("--permission bash=allow");
			expect(readFileSync(join(harness.tempDir, "notes.txt"), "utf8")).toBe("keep me\n");
			expect(existsSync(join(harness.tempDir, "notes.txt"))).toBe(true);
		},
		30_000,
	);

	it("outside auto, a user allow still runs the command with no UI", async () => {
		// Given the ask preset with a user allow for every command and no approver.
		const { harness, result } = await headless(
			[
				["permission-preset", "ask"],
				["permission", "bash=allow"],
			],
			"rm notes.txt",
		);
		// Then the allowed command runs.
		expect(result).not.toContain("Permission required");
		expect(existsSync(join(harness.tempDir, "notes.txt"))).toBe(false);
	}, 30_000);
});
