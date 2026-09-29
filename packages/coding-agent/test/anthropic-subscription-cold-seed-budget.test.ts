import { type Api, type AssistantMessage, type Context, isContextOverflow, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	COLD_SEED_OVERFLOW_DIAGNOSTIC,
	estimateColdSeedTokens,
} from "../src/core/extensions/builtin/anthropic-subscription/cold-seed-budget.ts";
import { forgetBinding } from "../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import { closeSession, getSession } from "../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { streamAnthropicSubscription } from "../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import {
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	sdkMessage,
} from "./helpers/anthropic-subscription-scripted-sdk.ts";

const SESSION_ID = "cold-seed-budget";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function priorAnswer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

/** A second-turn context with no resident session: the next dispatch is a cold-seed. */
function coldSeedContext(history: string): Context {
	return {
		systemPrompt: "SYSTEM",
		messages: [
			{ role: "user", content: "first", timestamp: 1 },
			priorAnswer(history),
			{ role: "user", content: "next", timestamp: 3 },
		],
	};
}

afterEach(() => {
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	resetScriptedSdk();
});

describe("anthropic-subscription cold-seed budget", () => {
	it("counts UTF-8 bytes, so CJK history is not under-counted like chars/4", () => {
		const hangul = estimateColdSeedTokens({}, [{ type: "text", text: "가".repeat(4_000) }]);
		const ascii = estimateColdSeedTokens({}, [{ type: "text", text: "a".repeat(4_000) }]);
		expect(hangul).toBeGreaterThan(ascii * 2.9);
	});

	it("counts the system prompt and tool schemas the re-send carries", () => {
		const blocks = [{ type: "text" as const, text: "history" }];
		const bare = estimateColdSeedTokens({}, blocks);
		const dressed = estimateColdSeedTokens(
			{
				systemPrompt: "s".repeat(4_000),
				tools: [{ name: "read", description: "d".repeat(4_000), parameters: {} as never }],
			},
			blocks,
		);
		expect(dressed - bare).toBeGreaterThanOrEqual(2_000);
	});

	it("refuses an oversized cold-seed before dispatch and marks it as a cold-seed overflow", async () => {
		await installSingleAccountLane();
		const queries = installScriptedSdk(() => {
			throw new Error("an oversized cold-seed must never be submitted");
		});
		const tight = { ...model, contextWindow: 1_000 };

		const result = await streamAnthropicSubscription(tight, coldSeedContext("x".repeat(8_000)), {
			sessionId: SESSION_ID,
			streamKind: "main",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(
			/^The conversation is too long to resend \(about \d+ tokens, limit 1000\)\. Compacting it and retrying\.$/,
		);
		expect(isContextOverflow(result, tight.contextWindow)).toBe(true);
		expect(result.diagnostics?.map((diagnostic) => diagnostic.type)).toContain(COLD_SEED_OVERFLOW_DIAGNOSTIC);
		expect(queries.flatMap((query) => query.submitted)).toEqual([]);
		expect(getSession(SESSION_ID)).toBeUndefined();
	});

	it("still dispatches a cold-seed that fits and leaves a successful turn unmarked", async () => {
		await installSingleAccountLane();
		const queries = installScriptedSdk((sessionId, userUuid) => [
			sdkMessage({
				type: "result",
				subtype: "success",
				result: "fits",
				user_message_uuid: userUuid,
				session_id: sessionId,
				usage: { input_tokens: 10, output_tokens: 1 },
			}),
		]);

		const result = await streamAnthropicSubscription(model, coldSeedContext("x".repeat(8_000)), {
			sessionId: SESSION_ID,
			streamKind: "main",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.diagnostics?.map((diagnostic) => diagnostic.type) ?? []).not.toContain(
			COLD_SEED_OVERFLOW_DIAGNOSTIC,
		);
		expect(queries.flatMap((query) => query.submitted)).toHaveLength(1);
	});
});
