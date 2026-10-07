import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { estimateTotalTokens } from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import { ResidentStringStore } from "../../src/core/session-resident-store.ts";

function textMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function prose(chars: number): string {
	return "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(Math.ceil(chars / 57)).slice(0, chars);
}

describe("per-message token estimate cache (senpi#2525)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reuses the cached estimate for an unchanged message", () => {
		// Given a message whose estimate requires JSON serialization
		const message = fauxAssistantMessage(
			[fauxToolCall("read", { path: "/src/a.ts", content: prose(400) }, { id: "call-1" })],
			{ stopReason: "toolUse" },
		);
		const stringify = vi.spyOn(JSON, "stringify");

		// When the same message object is estimated twice
		const first = estimateTokens(message);
		const callsAfterFirst = stringify.mock.calls.length;
		const second = estimateTokens(message);

		// Then the second estimate is the cached value: no re-serialization happened
		expect(second).toBe(first);
		expect(callsAfterFirst).toBeGreaterThan(0);
		expect(stringify.mock.calls.length).toBe(callsAfterFirst);

		// And the wire-level estimator reuses its own cached entry the same way
		const wireFirst = estimateTotalTokens([message]);
		const wireCallsAfterFirst = stringify.mock.calls.length;
		const wireSecond = estimateTotalTokens([message]);
		expect(wireSecond).toBe(wireFirst);
		expect(stringify.mock.calls.length).toBe(wireCallsAfterFirst);
	});

	it("re-estimates when a block's text is swapped in place", () => {
		// Given a cached estimate for a 4000-char text block (no base64/CJK runs)
		const message = textMessage(prose(4000));
		expect(estimateTokens(message)).toBe(1000);

		// When the resident store's in-place swap pattern replaces the text
		if (message.role !== "user" || typeof message.content === "string") {
			throw new Error("expected a user message with block content");
		}
		const block = message.content[0];
		if (block?.type !== "text") throw new Error("expected a text block");
		block.text = prose(1000);

		// Then the next estimate reflects the new content, not the cached identity
		expect(estimateTokens(message)).toBe(250);
	});

	it("estimates correctly after tokenize and materialize swap strings in place", () => {
		// Given a message with a string large enough for the resident store to tokenize
		const store = new ResidentStringStore();
		const message = textMessage(prose(40_000));
		const baseline = estimateTokens(message);
		expect(baseline).toBe(10_000);

		// When the store tokenizes the string in place (idle externalization)
		store.externalizeInPlace(message);
		const tokenized = estimateTokens(message);

		// Then the estimate tracks the token form, not the stale identity entry
		expect(tokenized).toBeLessThan(baseline);

		// And when the string is materialized back in place (request-time hydration)
		store.materializeInPlace(message);

		// Then the estimate returns to the exact baseline value
		expect(estimateTokens(message)).toBe(baseline);
	});
});
