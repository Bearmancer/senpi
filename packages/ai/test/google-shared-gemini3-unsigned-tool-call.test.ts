import { describe, expect, it } from "vitest";
import { convertMessages, requiresToolCallId } from "../src/api/google-shared.ts";
import type { Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Gemini 3+ strictly validates replayed tool calls: the first functionCall part of every step
// in the current turn must carry the thoughtSignature the model returned, or Vertex/AI Studio
// answer 400 "Function call is missing a thought_signature in functionCall parts". The
// skip_thought_signature_validator escape hatch is rejected by Vertex (pi-mono #4032), so a
// step whose calls carry no usable signature is replayed as text (call + paired result).
// Regression for a live omo session (2026-10-09): a transcript that ran on
// openrouter/deepseek-v4.1-flash switched to google-vertex/gemini-3.8-flash mid-session and
// every Gemini turn died on this 400.

function makeGemini3Model<TApi extends "google-generative-ai" | "google-vertex">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id = "gemini-3-pro-preview",
): Model<TApi> {
	return {
		id,
		name: "Gemini 3 Pro Preview",
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

const VALID_SIG = "AAAAAAAAAAAAAAAAAAAAAA==";

function makeContext(
	model: { api: string; provider: string; id: string },
	thoughtSignature?: string,
	firstResultIsError = false,
): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "Hi", timestamp: now },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "echo hi" },
						...(thoughtSignature && { thoughtSignature }),
					},
					{
						type: "toolCall",
						id: "call_2",
						name: "bash",
						arguments: { command: "ls -la" },
					},
				],
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
				stopReason: "toolUse",
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: firstResultIsError,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "bash",
				content: [{ type: "text", text: "files" }],
				isError: false,
				timestamp: now,
			},
		],
	};
}

describe("google-shared convertMessages — Gemini 3 unsigned tool calls", () => {
	it.each([
		makeGemini3Model("google-generative-ai", "google"),
		makeGemini3Model("google-generative-ai", "google", "gemini-3.6-flash"),
		makeGemini3Model("google-vertex", "google-vertex"),
	])("preserves tool call IDs for $id via $api history", (model) => {
		const context = makeContext(model, VALID_SIG);
		const contents = convertMessages(model, normalizeContext(context));
		const functionCallIds = contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionCall?.id ? [part.functionCall.id] : []));
		const functionResponseIds = contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionResponse?.id ? [part.functionResponse.id] : []));

		expect(functionCallIds).toEqual(["call_1", "call_2"]);
		expect(functionResponseIds).toEqual(["call_1", "call_2"]);
	});

	it("replays unsigned tool calls and their results as text for Vertex Gemini 3", () => {
		// Given: history recorded on another provider (the reported mid-session model switch).
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = convertMessages(
			model,
			normalizeContext(
				makeContext({ api: "openai-completions", provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" }),
			),
		);

		expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
		const callParts = contents[1]?.parts ?? [];
		expect(callParts).toHaveLength(2);
		expect(callParts.every((part) => part.functionCall === undefined)).toBe(true);
		expect(callParts[0]?.text).toBe('[Tool Call: bash]\nArguments: {\n  "command": "echo hi"\n}');
		expect(callParts[1]?.text).toContain('"command": "ls -la"');
		const resultParts = contents[2]?.parts ?? [];
		expect(resultParts).toHaveLength(2);
		expect(resultParts.every((part) => part.functionResponse === undefined)).toBe(true);
		expect(resultParts[0]?.text).toBe("[Tool Result: bash]\nhi");
		expect(resultParts[1]?.text).toBe("[Tool Result: bash]\nfiles");
		expect(JSON.stringify(contents)).not.toContain("skip_thought_signature_validator");
	});

	it("replays same-model unsigned tool calls as text too", () => {
		// A same-model turn the API answered without a signature cannot be replayed structured either.
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = convertMessages(model, normalizeContext(makeContext(model)));

		const parts = contents.flatMap((content) => content.parts ?? []);
		expect(parts.some((part) => part.functionCall !== undefined)).toBe(false);
		expect(parts.some((part) => part.functionResponse !== undefined)).toBe(false);
		expect(parts.filter((part) => part.text?.startsWith("[Tool Call: bash]"))).toHaveLength(2);
		expect(parts.filter((part) => part.text?.startsWith("[Tool Result: bash]"))).toHaveLength(2);
	});

	it("marks an errored text-replayed tool result", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = convertMessages(
			model,
			normalizeContext(
				makeContext(
					{ api: "openai-completions", provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
					undefined,
					true,
				),
			),
		);

		const resultParts = contents[2]?.parts ?? [];
		expect(resultParts[0]?.text).toBe("[Tool Result: bash] (error)\nhi");
	});

	it("keeps a step structured when its first tool call carries a valid signature", () => {
		// Parallel calls of one response legitimately carry the signature on the first part only.
		const model = makeGemini3Model("google-generative-ai", "google");
		const contents = convertMessages(model, normalizeContext(makeContext(model, VALID_SIG)));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBe(VALID_SIG);
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
	});

	it("omits standalone same-model thinking replay when thinking is off", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const contents = convertMessages(
			model,
			normalizeContext({
				messages: [
					{ role: "user", content: "first turn", timestamp: Date.now() },
					{
						role: "assistant",
						api: "google-generative-ai",
						provider: "google",
						model: model.id,
						content: [
							{
								type: "thinking",
								thinking: "prior Google thinking",
								thinkingSignature: "AAAAAAAAAAAAAAAAAAAAAA==",
							},
							{ type: "text", text: "previous answer", textSignature: "BBBBBBBBBBBBBBBBBBBBBB==" },
						],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
					{ role: "user", content: "follow-up", timestamp: Date.now() },
				],
			}),
			{ preserveThinking: false },
		);
		const modelTurn = contents.find((content) => content.role === "model");

		expect(modelTurn?.parts).toEqual([{ text: "previous answer" }]);
	});

	it("does not replay unsigned tool calls as text for non-Gemini-3 models", () => {
		const model = makeGemini3Model("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = convertMessages(model, normalizeContext(makeContext({ ...model, id: "other-model" })));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((part) => part.functionCall !== undefined) ?? [];
		const functionResponseParts = contents
			.flatMap((content) => content.parts ?? [])
			.filter((part) => part.functionResponse !== undefined);

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts.every((part) => part.functionCall?.id === undefined)).toBe(true);
		expect(functionCallParts.every((part) => part.thoughtSignature === undefined)).toBe(true);
		expect(functionResponseParts).toHaveLength(2);
		expect(functionResponseParts.every((part) => part.functionResponse?.id === undefined)).toBe(true);
	});
});

describe("requiresToolCallId", () => {
	it.each([
		[false, "gemini-2.5-flash"],
		[true, "gemini-3.6-flash"],
		[true, "claude-sonnet-4-5"],
		[true, "gpt-oss-120b"],
	] as const)("returns %s for %s", (expected, modelId) => {
		expect(requiresToolCallId(modelId)).toBe(expected);
	});
});
