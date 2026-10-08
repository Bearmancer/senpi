import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import ttsrExtension from "../../../src/core/extensions/builtin/ttsr/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const QUEUED_REPLIES = 14;

function repeatingReplies(): () => ReturnType<typeof fauxAssistantMessage> {
	let request = 0;
	return () =>
		fauxAssistantMessage([
			fauxText(
				`qa-local-model replies to ${(0xabc123 + request++ * 7919).toString(16)}f00d: the deterministic mock answer for this request.`,
			),
		]);
}

function nudgeCount(harness: Harness): number {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "ttsr-injection",
	).length;
}

function userCount(harness: Harness): number {
	return harness.session.messages.filter((message) => message.role === "user").length;
}

async function drain(harness: Harness): Promise<void> {
	for (let pass = 0; pass < QUEUED_REPLIES * 4; pass++) {
		await harness.session.waitForIdle();
		await Promise.resolve();
	}
}

describe("senpi#2967 rule-injected repetitive-turns follow-ups are bounded", () => {
	let harness: Harness;

	afterEach(() => {
		harness.cleanup();
	});

	it("stops after one rule-injected follow-up even when the ttsr state is rebuilt every turn", async () => {
		// given a model that keeps answering with the same template, and a host that rebuilds the
		// extension state between turns (as the desktop's server-hosted session does)
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		const reply = repeatingReplies();
		harness.setResponses(Array.from({ length: QUEUED_REPLIES }, () => reply));
		await harness.session.prompt("first message");
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") void harness.session.reload();
		});
		const callsBefore = harness.faux.getCallLog().length;

		// when one more user message arrives
		await harness.session.prompt("After edit check");
		await drain(harness);

		// then at most one rule-injected follow-up runs for that single user message
		expect(userCount(harness)).toBe(2);
		expect(nudgeCount(harness)).toBeLessThanOrEqual(1);
		expect(harness.faux.getCallLog().length - callsBefore).toBeLessThanOrEqual(2);
	});

	it("still gives a repetitive reply exactly one corrective follow-up", async () => {
		// given the same repeating model without any state rebuild
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		const reply = repeatingReplies();
		harness.setResponses(Array.from({ length: QUEUED_REPLIES }, () => reply));
		await harness.session.prompt("first message");
		const callsBefore = harness.faux.getCallLog().length;

		// when one more user message arrives
		await harness.session.prompt("After edit check");
		await drain(harness);

		// then the rule still nudges once and the model gets one recovery turn
		expect(nudgeCount(harness)).toBe(1);
		expect(harness.faux.getCallLog().length - callsBefore).toBe(2);
	});
});
