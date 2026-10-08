import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { type BedrockOptions, stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel, getModels, normalizeContext, streamSimple } from "../src/compat.ts";
import { calculateCost, getSupportedThinkingLevels } from "../src/models.ts";
import type { Context, Model, SimpleStreamOptions, Usage } from "../src/types.ts";
import { getAnthropicCompat } from "../src/utils/prompt-cache-ttl.ts";

// Claude Haiku 5.5 (2026-10-07), senpi#2892. Generated-catalog and request-shape contract.
// https://platform.claude.com/docs/en/models/haiku-5-5/overview and .../haiku-5-5/migration-guide:
// 1M in / 128k out, text + image input, adaptive thinking with effort low..max (`budget_tokens` is a
// 400, so `thinking` stays unset or adaptive), no `temperature` / `top_p` / `top_k`, forced
// `tool_choice` accepted (unlike Opus/Sonnet 5.5), no server-side refusal fallback, and $0.1 / $0.5
// per MTok with 0.01 cache reads and 0.125 cache writes; a prompt over 100,000 input tokens bills
// the whole request at 0.5 / 2.5 / 0.05 / 0.625.

const HAIKU_55_COST = {
	input: 0.1,
	output: 0.5,
	cacheRead: 0.01,
	cacheWrite: 0.125,
	tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
};

interface AnthropicPayload {
	messages: Array<{ role: string; output_config?: { effort?: string } }>;
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
	tool_choice?: { type: string; name?: string };
	temperature?: number;
	top_p?: number;
	top_k?: number;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(withTool = false): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		...(withTool
			? {
					tools: [
						{
							name: "lookup",
							description: "Look up a value",
							parameters: Type.Object({ key: Type.String() }),
						},
					],
				}
			: {}),
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicPayload> {
	let captured: AnthropicPayload | undefined;
	const s = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await s.result();
	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

function haiku55(): Model<"anthropic-messages"> {
	const model = getModel("anthropic", "claude-haiku-5-5");
	expect(model, "anthropic/claude-haiku-5-5 must exist in the generated catalog").toBeDefined();
	return model as Model<"anthropic-messages">;
}

function mapLessHaiku55(): Model<"anthropic-messages"> {
	return {
		id: "claude-haiku-5-5",
		name: "Claude Haiku 5.5",
		api: "anthropic-messages",
		provider: "custom-gateway",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

function usage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("Claude Haiku 5.5 catalog row (anthropic)", () => {
	it("carries the documented limits, input, prices and effort ladder", () => {
		const model = haiku55();
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.cost).toEqual(HAIKU_55_COST);
		expect(model.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("is adaptive-only with per-message effort, keeps forced tool choice and has no refusal fallback", () => {
		const model = haiku55();
		expect(model.thinkingLevelMap?.off).toBeNull();
		expect(model.compat?.supportsDisabledThinking).toBe(false);
		expect(model.compat?.forceAdaptiveThinking).toBe(true);
		expect(model.compat?.supportsTemperature).toBe(false);
		expect(model.compat?.supportsMidConvoEffort).toBe(true);
		expect(model.compat?.supportsMidConvoSystemMessages).toBe(true);
		expect(model.compat?.allowedFallbackModels).toBeUndefined();
		expect(getAnthropicCompat(model).supportsForcedToolChoice).toBe(true);
	});

	it("bills a prompt over 100,000 input tokens entirely at the long-context rate", () => {
		const model = haiku55();
		const long = calculateCost(model, usage(150_000, 2_000));
		expect(long.input).toBeCloseTo(0.075, 10);
		expect(long.output).toBeCloseTo(0.005, 10);
		// Exactly 100,000 is not "over 100K": the base rate still applies.
		const atThreshold = calculateCost(model, usage(100_000, 2_000));
		expect(atThreshold.input).toBeCloseTo(0.01, 10);
		expect(atThreshold.output).toBeCloseTo(0.001, 10);
	});
});

describe("Claude Haiku 5.5 catalog rows (Amazon Bedrock)", () => {
	it("ships the on-demand id and the global inference profile with the same contract", () => {
		const ids = getModels("amazon-bedrock").map((model) => model.id);
		expect(ids).toContain("anthropic.claude-haiku-5-5");
		expect(ids).toContain("global.anthropic.claude-haiku-5-5");
		for (const id of ["anthropic.claude-haiku-5-5", "global.anthropic.claude-haiku-5-5"] as const) {
			const model = getModel("amazon-bedrock", id);
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(128_000);
			expect(model.cost).toEqual(HAIKU_55_COST);
			expect(model.thinkingLevelMap?.off).toBeNull();
			expect(getSupportedThinkingLevels(model)).not.toContain("off");
			expect(getSupportedThinkingLevels(model)).toEqual(
				expect.arrayContaining(["low", "medium", "high", "xhigh", "max"]),
			);
		}
	});

	it("sends adaptive thinking with an effort, never budget_tokens", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-haiku-5-5");
		expect(
			model,
			"amazon-bedrock/global.anthropic.claude-haiku-5-5 must exist in the generated catalog",
		).toBeDefined();
		let captured:
			| { additionalModelRequestFields?: { thinking?: { type: string; budget_tokens?: number } } }
			| undefined;
		const options: BedrockOptions = {
			reasoning: "medium",
			signal: AbortSignal.abort(),
			onPayload: (payload) => {
				captured = payload as typeof captured;
				return payload;
			},
		};
		for await (const event of streamBedrock(model, normalizeContext(makeContext()), options)) {
			if (event.type === "error") break;
		}
		expect(captured?.additionalModelRequestFields).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "medium" },
		});
		expect(captured?.additionalModelRequestFields?.thinking?.budget_tokens).toBeUndefined();
	});
});

describe("Claude Haiku 5.5 request shape (anthropic-messages)", () => {
	it("runs adaptive thinking with per-message effort and sends no sampling params", async () => {
		const payload = await capturePayload(haiku55(), { reasoning: "medium", temperature: 0.2 });
		expect(payload.thinking).toEqual({
			type: "adaptive",
			display: "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		expect(payload.messages.at(-1)).toMatchObject({ output_config: { effort: "medium" } });
		expect(payload).not.toHaveProperty("temperature");
		expect(payload).not.toHaveProperty("top_p");
		expect(payload).not.toHaveProperty("top_k");
	});

	it("never sends thinking.type=disabled or a temperature on a thinking-off turn", async () => {
		const payload = await capturePayload(haiku55(), { temperature: 0.2 });
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "low" });
		expect(payload).not.toHaveProperty("temperature");
	});

	it("keeps a forced tool_choice, which Haiku 5.5 accepts", async () => {
		let captured: AnthropicPayload | undefined;
		const s = streamAnthropic({ ...haiku55(), baseUrl: "http://127.0.0.1:9" }, normalizeContext(makeContext(true)), {
			apiKey: "fake-key",
			thinkingEnabled: true,
			effort: "medium",
			toolChoice: { type: "tool", name: "lookup" },
			onPayload: (payload) => {
				captured = payload as AnthropicPayload;
				throw new PayloadCaptured();
			},
		});
		await s.result();
		expect(captured?.tool_choice).toEqual({ type: "tool", name: "lookup" });
	});

	it("pins effort low for a thinking-off turn on a map-less gateway row", async () => {
		const payload = await capturePayload(mapLessHaiku55());
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "low" });
	});

	it.each([
		["medium", "medium"],
		["xhigh", "xhigh"],
		["max", "max"],
	] as const)("maps reasoning %s to adaptive effort %s on a map-less gateway row", async (reasoning, effort) => {
		const payload = await capturePayload(mapLessHaiku55(), { reasoning });
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort });
	});
});
