import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import { HANDOFF_CUES, handoffMomentOf, type TodoPhase } from "../../src/core/extensions/builtin/todotools/state.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function phases(...spec: Array<[string, ...Array<[string, TodoPhase["tasks"][number]["status"]]>]>): TodoPhase[] {
	return spec.map(([name, ...tasks]) => ({ name, tasks: tasks.map(([content, status]) => ({ content, status })) }));
}

describe("handoffMomentOf", () => {
	const open = phases(["Build", ["a", "in_progress"], ["b", "pending"]], ["Check", ["c", "pending"]]);

	it("reports list-created for a list-creating call with tasks", () => {
		// given: no list before, a list after
		// when/then
		expect(handoffMomentOf([], open, true)).toBe("list-created");
	});

	it("reports phase-closed when the last open task of a phase closes", () => {
		// given: Build has one open task left
		const before = phases(["Build", ["a", "completed"], ["b", "in_progress"]], ["Check", ["c", "pending"]]);
		const after = phases(["Build", ["a", "completed"], ["b", "completed"]], ["Check", ["c", "in_progress"]]);
		// when/then
		expect(handoffMomentOf(before, after, false)).toBe("phase-closed");
	});

	it("reports all-closed when the last open task of the list closes, dropped tasks included", () => {
		// given: one open task left in the whole list
		const before = phases(["Build", ["a", "completed"], ["b", "completed"]], ["Check", ["c", "in_progress"]]);
		const after = phases(["Build", ["a", "completed"], ["b", "completed"]], ["Check", ["c", "abandoned"]]);
		// when/then
		expect(handoffMomentOf(before, after, false)).toBe("all-closed");
	});

	it("reports nothing for a mid-phase transition or an already-closed list", () => {
		// given: a task closes while its phase still has open work; a closed list stays closed
		const midAfter = phases(["Build", ["a", "completed"], ["b", "in_progress"]], ["Check", ["c", "pending"]]);
		const closed = phases(["Build", ["a", "completed"]]);
		// when/then
		expect(handoffMomentOf(open, midAfter, false)).toBeUndefined();
		expect(handoffMomentOf(closed, closed, false)).toBeUndefined();
		expect(handoffMomentOf([], [], true)).toBeUndefined();
	});
});

describe("todo results carry the handoff cue at handoff moments", () => {
	it("appends the list-created, phase-closed, and all-closed cues and nothing mid-phase", async () => {
		// given: a session running four todo calls in one turn
		const harness = await createHarness({ extensionFactories: [todotoolsExtension] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("todo", {
						op: "init",
						list: [
							{ phase: "Build", items: ["a", "b"] },
							{ phase: "Check", items: ["c"] },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("todo", { op: "done", task: "a" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("todo", { op: "done", task: "b" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("todo", { op: "done", task: "c" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);

		// when
		await harness.session.prompt("Build a, b, then check c.");

		// then: each result ends with the cue for its moment, and the mid-phase done carries none
		const texts = harness.session.messages.flatMap((message) =>
			message.role === "toolResult" && message.toolName === "todo" ? [getMessageText(message)] : [],
		);
		expect(texts).toHaveLength(4);
		expect(texts[0]?.endsWith(HANDOFF_CUES["list-created"])).toBe(true);
		expect(Object.values(HANDOFF_CUES).some((cue) => texts[1]?.includes(cue))).toBe(false);
		expect(texts[2]?.endsWith(HANDOFF_CUES["phase-closed"])).toBe(true);
		expect(texts[3]?.endsWith(HANDOFF_CUES["all-closed"])).toBe(true);
	});
});
