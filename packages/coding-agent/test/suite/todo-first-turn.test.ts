import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	FIRST_TURN_CUSTOM_TYPE,
	type FirstTurnGateInput,
	namedToolChoicePayload,
	shouldArmFirstTurn,
	supportsNamedToolChoice,
} from "../../src/core/extensions/builtin/todotools/first-turn.ts";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

function model(id: string, api: Api = "anthropic-messages", compat?: Record<string, unknown>): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider: api === "anthropic-messages" ? "anthropic" : "openai",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		...(compat ? { compat } : {}),
	} as Model<Api>;
}

const USER_ENTRY: SessionEntry = {
	type: "message",
	id: "u-1",
	parentId: null,
	timestamp: "2026-09-24T00:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text: "earlier request" }], timestamp: 0 },
};

const ARMED: FirstTurnGateInput = {
	preview: false,
	trigger: "prompt",
	prompt: "add retries to fetchUser",
	branchEntries: [],
	todoActive: true,
	setting: "force",
	mode: "tui",
};

describe("shouldArmFirstTurn", () => {
	it.each<[string, Partial<FirstTurnGateInput>, boolean]>([
		["arms for a first work request in the TUI", {}, true],
		["arms for a child session over rpc", { mode: "rpc" }, true],
		["arms for the remind setting", { setting: "remind" }, true],
		["skips a question", { prompt: "why does fetchUser fail?" }, false],
		["skips an exclamation behind a closing quote and paren", { prompt: 'ship it!")  ' }, false],
		["skips a blank prompt", { prompt: "   " }, false],
		["skips a branch with a prior user message", { branchEntries: [USER_ENTRY] }, false],
		["skips an extension-triggered turn", { trigger: "extension" }, false],
		["skips an inactive todo tool", { todoActive: false }, false],
		["skips a preview", { preview: true }, false],
		["skips the off setting", { setting: "off" }, false],
		["skips print mode", { mode: "print" }, false],
		["skips json mode", { mode: "json" }, false],
	])("%s", (_label, override, expected) => {
		// given
		const input = { ...ARMED, ...override };

		// when
		const armed = shouldArmFirstTurn(input);

		// then
		expect(armed).toBe(expected);
	});
});

describe("named tool_choice wire shapes", () => {
	it.each<[Api, unknown]>([
		["anthropic-messages", { type: "tool", name: "todo" }],
		["openai-responses", { type: "function", name: "todo" }],
		["openai-completions", { type: "function", function: { name: "todo" } }],
		["google-generative-ai", undefined],
	])("%s", (api, expected) => {
		expect(namedToolChoicePayload(api, "todo")).toEqual(expected);
	});

	it.each<[string, Model<Api>, boolean]>([
		["claude-fable-5-1 through the resolved compat default", model("claude-fable-5-1"), false],
		["claude-opus-5 through the resolved compat default", model("claude-opus-5"), true],
		[
			"claude-opus-5 with forced tool choice disabled",
			model("claude-opus-5", "anthropic-messages", { supportsForcedToolChoice: false }),
			false,
		],
		["openai-responses", model("gpt-5.6", "openai-responses"), true],
		["openai-completions", model("grok-4.7", "openai-completions"), true],
		["google-generative-ai", model("gemini-3", "google-generative-ai"), false],
	])("supportsNamedToolChoice: %s", (_label, candidate, expected) => {
		expect(supportsNamedToolChoice(candidate)).toBe(expected);
	});
});

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

const tempDirs: string[] = [];
const harnesses: Harness[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function fauxPi(options: { setting?: string } = {}) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		appendEntry: () => {},
		getActiveTools: () => ["read", "todo"],
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	} as unknown as ExtensionAPI;
	todotoolsExtension(pi);
	const root = mkdtempSync(join(tmpdir(), "todo-first-turn-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	if (options.setting) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ todo: { firstTurnPlan: options.setting } }));
	}
	const ctx = {
		cwd: root,
		agentDir,
		mode: "tui",
		model: model("claude-opus-5"),
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => [] },
		ui: { setWidget: () => {} },
	} as unknown as ExtensionContext;
	const emit = async (event: string, payload: Record<string, unknown> = {}) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...payload }, ctx);
		return result;
	};
	const startTurn = () =>
		emit("before_agent_start", {
			prompt: "add retries to fetchUser",
			trigger: "prompt",
			systemPrompt: "base",
		}) as Promise<{
			message?: { customType: string };
		}>;
	const providerRequest = (payload: Record<string, unknown>, requestModel: Model<Api> = model("claude-opus-5")) =>
		emit("before_provider_request", { payload, model: requestModel }) as Promise<
			{ tool_choice?: unknown } | undefined
		>;
	return { emit, startTurn, providerRequest };
}

const TODO_PAYLOAD = { tools: [{ name: "read" }, { name: "todo" }] };

describe("first-turn tool_choice through the faux pi shape", () => {
	it("forces the todo tool on the armed first request", async () => {
		// given
		const faux = fauxPi();
		const start = await faux.startTurn();

		// when
		const payload = await faux.providerRequest(TODO_PAYLOAD);

		// then
		expect(start.message?.customType).toBe(FIRST_TURN_CUSTOM_TYPE);
		expect(payload?.tool_choice).toEqual({ type: "tool", name: "todo" });
	});

	it("leaves tool_choice absent when the model rejects forced tool choice", async () => {
		// given
		const faux = fauxPi();
		await faux.startTurn();

		// when
		const payload = await faux.providerRequest(
			TODO_PAYLOAD,
			model("claude-opus-5", "anthropic-messages", { supportsForcedToolChoice: false }),
		);

		// then
		expect(payload?.tool_choice).toBeUndefined();
	});

	it("leaves the payload alone without a todo tool, with its own tool_choice, or with Anthropic thinking", async () => {
		// given
		const faux = fauxPi();
		await faux.startTurn();

		// when
		const results = [
			await faux.providerRequest({ tools: [{ name: "read" }] }),
			await faux.providerRequest({ ...TODO_PAYLOAD, tool_choice: { type: "auto" } }),
			await faux.providerRequest({ ...TODO_PAYLOAD, thinking: { type: "adaptive" } }),
		];

		// then
		expect(results).toEqual([undefined, undefined, undefined]);
	});

	it("does not force the second request after the first assistant message ends", async () => {
		// given
		const faux = fauxPi();
		await faux.startTurn();
		await faux.providerRequest(TODO_PAYLOAD);

		// when
		await faux.emit("message_end", { message: { role: "assistant", content: [] } });
		const second = await faux.providerRequest(TODO_PAYLOAD);

		// then
		expect(second?.tool_choice).toBeUndefined();
	});

	it("clears the pending force on agent_end without an assistant message", async () => {
		// given
		const faux = fauxPi();
		await faux.startTurn();

		// when
		await faux.emit("agent_end", { messages: [] });
		const payload = await faux.providerRequest(TODO_PAYLOAD);

		// then
		expect(payload?.tool_choice).toBeUndefined();
	});

	it("sends only the reminder under the remind setting", async () => {
		// given
		const faux = fauxPi({ setting: "remind" });

		// when
		const start = await faux.startTurn();
		const payload = await faux.providerRequest(TODO_PAYLOAD);

		// then
		expect(start.message?.customType).toBe(FIRST_TURN_CUSTOM_TYPE);
		expect(payload?.tool_choice).toBeUndefined();
	});
});

async function createTuiHarness(): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [todotoolsExtension] });
	harnesses.push(harness);
	harness.getExtensionRunner().setUIContext(undefined, "tui");
	return harness;
}

function firstTurnEntries(harness: Harness): SessionEntry[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === FIRST_TURN_CUSTOM_TYPE);
}

describe("first-turn reminder through the real AgentSession", () => {
	it("persists the hidden reminder on the first prompt and not on the second", async () => {
		// given
		const harness = await createTuiHarness();
		harness.setResponses([fauxAssistantMessage("on it"), fauxAssistantMessage("still on it")]);

		// when
		await harness.session.prompt("add retries to fetchUser");
		await harness.session.prompt("also cover the timeout path");

		// then
		const entries = firstTurnEntries(harness);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.type === "custom_message" ? entries[0].display : undefined).toBe(false);
	}, 20_000);

	it("arms on the user's first request after an extension-triggered turn planned its own list (senpi#2137)", async () => {
		// given: an extension triggers a hidden turn before the user speaks, and that turn inits a list
		const harness = await createTuiHarness();
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("todo", { op: "init", list: [{ phase: "Onboarding", items: ["Greet the user"] }] })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("welcome"),
			fauxAssistantMessage("on it"),
		]);
		await harness.session.sendCustomMessage(
			{ customType: "test:bootstrap", content: "Greet the user.", display: false },
			{ triggerTurn: true },
		);
		expect(firstTurnEntries(harness)).toHaveLength(0);

		// when
		await harness.session.prompt("add retries to fetchUser");

		// then
		expect(firstTurnEntries(harness)).toHaveLength(1);
	}, 20_000);

	it("does not arm for a question", async () => {
		// given
		const harness = await createTuiHarness();
		harness.setResponses([fauxAssistantMessage("it retries twice")]);

		// when
		await harness.session.prompt("how does fetchUser retry?");

		// then
		expect(firstTurnEntries(harness)).toHaveLength(0);
	}, 20_000);
});
