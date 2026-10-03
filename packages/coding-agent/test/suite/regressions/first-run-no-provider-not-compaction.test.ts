import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const COMPACTION_ERROR = "Context remains above the compaction threshold";

const NO_PROVIDER_PLACEHOLDER = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<string>;

describe("a first run with no provider configured", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function firstRunSession(): Promise<Harness> {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		harness.session.agent.state.model = NO_PROVIDER_PLACEHOLDER;
		return harness;
	}

	it("#given no provider #when the user sends a message #then the error says no provider, not that compaction failed", async () => {
		// given
		const harness = await firstRunSession();

		// when
		const outcome = harness.session.prompt("hello").then(
			() => "accepted",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

		// then
		const message = await outcome;
		expect(message).not.toContain(COMPACTION_ERROR);
		expect(message).toContain("/login");
		expect(harness.faux.getCallLog()).toEqual([]);
	});

	it("#given no provider #when an extension triggers a turn #then it fails with the no-provider guidance, not a compaction error", async () => {
		// given
		const harness = await firstRunSession();

		// when
		const outcome = harness.session
			.sendCustomMessage({ customType: "startup-note", content: "ready", display: false }, { triggerTurn: true })
			.then(
				() => "accepted",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);

		// then
		const message = await outcome;
		expect(message).not.toContain(COMPACTION_ERROR);
		expect(message).toContain("/login");
		expect(harness.faux.getCallLog()).toEqual([]);
	});

	it("#given a model whose context window is unknown #when a turn is admitted #then it is not treated as over the compaction threshold", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = { ...harness.getModel(), contextWindow: 0 };
		harness.setResponses([]);

		// when
		const outcome = harness.session
			.sendCustomMessage({ customType: "startup-note", content: "ready", display: false }, { triggerTurn: true })
			.then(
				() => "accepted",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);

		// then
		expect(await outcome).not.toContain(COMPACTION_ERROR);
	});

	it("#given no provider #when a startup extension triggers turns twice #then the user sees the /login guidance once and no extension error", async () => {
		// given
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.session.agent.state.model = NO_PROVIDER_PLACEHOLDER;
		const extensionErrors: string[] = [];
		harness.getExtensionRunner().onError((error) => extensionErrors.push(error.error));
		const typedPromptGuidance = await harness.session.prompt("hello").then(
			() => "accepted",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

		// when
		api?.sendMessage({ customType: "startup-note", content: "ready", display: false }, { triggerTurn: true });
		api?.sendMessage({ customType: "startup-note", content: "again", display: false }, { triggerTurn: true });
		await harness.session.waitForSettledSessionWork();

		// then
		expect(extensionErrors).toEqual([]);
		expect(harness.eventsOfType("provider_required").map((event) => event.notice)).toEqual([typedPromptGuidance]);
		expect(harness.faux.getCallLog()).toEqual([]);
	});
});
