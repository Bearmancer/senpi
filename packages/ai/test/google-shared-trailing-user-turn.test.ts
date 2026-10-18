import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/google-shared.ts";
import type { AssistantMessage, Context, Model, ToolCall } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Regression for #3633: a user message that directly follows tool results (a steering message, a
// recalled-memory notice, a hidden reminder) is folded into the tool-result user turn. Vertex reads
// that turn as a malformed model turn when its function responses are followed by other parts, and
// it validates thought signatures on the final model turn only - both shapes are pinned here.

function makeModel<TApi extends "google-generative-ai" | "google-vertex">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id: string,
): Model<TApi> {
	return {
		id,
		name: id,
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

const argon = makeModel("google-vertex", "google-vertex", "gemini-4-argon");
const gemini3 = makeModel("google-vertex", "google-vertex", "gemini-3.1-pro-preview");

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}

function toolCall(id: string, name = "bash", thoughtSignature?: string): ToolCall {
	return {
		type: "toolCall",
		id,
		name,
		arguments: { command: "echo hi" },
		...(thoughtSignature ? { thoughtSignature } : {}),
	};
}

function assistantMessage(
	model: { api: string; provider: string; id: string },
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		timestamp: 2,
	};
}

function toolResultMessage(toolCallId: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "bash",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: 3,
	};
}

function partKinds(
	parts: Array<{ functionCall?: unknown; functionResponse?: unknown; text?: string }> | undefined,
): string[] {
	return (parts ?? []).map((part) =>
		part.functionCall ? "functionCall" : part.functionResponse ? "functionResponse" : "text",
	);
}

const signature = "AAAAAAAAAAAAAAAAAAAAAA==";

describe("google-shared tool-result turns followed by a user message", () => {
	it("keeps the trailing user turn's function responses last in the turn", () => {
		const context: Context = {
			messages: [
				userMessage("Run the command"),
				assistantMessage(argon, [toolCall("call_1", "bash", signature)]),
				toolResultMessage("call_1", "hi"),
				userMessage("Extra note"),
			],
		};

		const contents = convertMessages(argon, normalizeContext(context));

		expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
		expect(partKinds(contents[2]?.parts)).toEqual(["text", "functionResponse"]);
	});

	it("keeps tool results and the following message in one user turn", () => {
		const context: Context = {
			messages: [
				userMessage("Run the command"),
				assistantMessage(argon, [toolCall("call_1", "bash", signature), toolCall("call_2")]),
				toolResultMessage("call_1", "one"),
				toolResultMessage("call_2", "two"),
				userMessage("Extra note"),
			],
		};

		const contents = convertMessages(argon, normalizeContext(context));

		expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
		expect(partKinds(contents[2]?.parts)).toEqual(["text", "functionResponse", "functionResponse"]);
	});

	it("replays the live model turn's unsigned tool call as text when a user message follows its results", () => {
		const context: Context = {
			messages: [
				userMessage("Run the command"),
				assistantMessage({ api: gemini3.api, provider: gemini3.provider, id: "other-model" }, [toolCall("call_1")]),
				toolResultMessage("call_1", "hi"),
				userMessage("Extra note"),
			],
		};

		const contents = convertMessages(gemini3, normalizeContext(context));
		const modelTurns = contents.filter((content) => content.role === "model");

		expect(modelTurns).toHaveLength(1);
		expect(partKinds(modelTurns[0]?.parts)).toEqual(["text"]);
		expect(modelTurns[0]?.parts?.[0]?.text).toContain("[Tool Call: bash");
	});

	it("keeps the previous part order for a model that does not enforce it", () => {
		const gemini25 = makeModel("google-vertex", "google-vertex", "gemini-2.5-pro");
		const context: Context = {
			messages: [
				userMessage("Run the command"),
				assistantMessage(gemini25, [toolCall("call_1", "bash", signature)]),
				toolResultMessage("call_1", "hi"),
				userMessage("Extra note"),
			],
		};

		const contents = convertMessages(gemini25, normalizeContext(context));

		expect(partKinds(contents[2]?.parts)).toEqual(["functionResponse", "text"]);
	});

	it("keeps structured function calls for model turns that are not the live one", () => {
		const context: Context = {
			messages: [
				userMessage("Run the command"),
				assistantMessage({ api: gemini3.api, provider: gemini3.provider, id: "other-model" }, [toolCall("call_1")]),
				toolResultMessage("call_1", "hi"),
				assistantMessage({ api: gemini3.api, provider: gemini3.provider, id: "other-model" }, [toolCall("call_2")]),
				toolResultMessage("call_2", "there"),
				userMessage("Extra note"),
			],
		};

		const contents = convertMessages(gemini3, normalizeContext(context));
		const modelTurns = contents.filter((content) => content.role === "model");

		expect(modelTurns).toHaveLength(2);
		expect(partKinds(modelTurns[0]?.parts)).toEqual(["functionCall"]);
		expect(partKinds(modelTurns[1]?.parts)).toEqual(["text"]);
	});
});
