import type { Api, Model } from "@earendil-works/pi-ai";
import { getAnthropicCompat } from "@earendil-works/pi-ai/utils/prompt-cache-ttl";
import type { SessionEntry } from "../../../session-manager.ts";
import type { TodoFirstTurnPlan } from "../../../settings-shapes.ts";
import type { ExtensionMode } from "../../types.ts";

export const FIRST_TURN_CUSTOM_TYPE = "senpi.todo-first-turn";

export const FIRST_TURN_REMINDER = `<system-reminder>
This is the first request of the session. Before continuing, call the todo tool with op "init" and a phased list covering the whole request end to end: investigation, implementation, verification (diagnostics, tests, build, manual check), and the final report. Give every task a unique 5-10 word label; phase names are short noun phrases. Then continue the request in this same turn - the init is not a turn by itself.
</system-reminder>`;

/** One-shot, non-interactive runs; the same set `terminal/notify.ts` never wakes. */
const NON_INTERACTIVE_MODES: ReadonlySet<ExtensionMode> = new Set(["print", "json"]);

const TRAILING_CLOSERS = /[\s"'`\u2018\u2019\u201C\u201D)\]}]+$/u;

export type FirstTurnGateInput = {
	preview: boolean | undefined;
	trigger: "prompt" | "extension";
	prompt: string;
	branchEntries: readonly SessionEntry[];
	todoActive: boolean;
	setting: TodoFirstTurnPlan;
	mode: ExtensionMode;
};

/**
 * Arms the first-turn plan opener only for a session's first user-authored request that asks for
 * work: never in a preview, never on a turn an extension triggered (senpi#2137), never once any
 * user message is on the branch (`before_agent_start` fires before the prompt is persisted), never
 * for a question or an exclamation, and never in print/json runs. Before the first user message a
 * list can only come from an extension-triggered turn, so an existing list does not block the
 * user's first request.
 */
export function shouldArmFirstTurn(input: FirstTurnGateInput): boolean {
	if (input.preview || input.trigger !== "prompt" || input.setting === "off" || !input.todoActive) return false;
	if (NON_INTERACTIVE_MODES.has(input.mode)) return false;
	const request = input.prompt.trim().replace(TRAILING_CLOSERS, "");
	if (request === "" || /[?!\uFF1F\uFF01]$/u.test(request)) return false;
	return !input.branchEntries.some((entry) => entry.type === "message" && entry.message.role === "user");
}

/**
 * Whether the request wire can name one tool in `tool_choice`. Anthropic reads the RESOLVED
 * compat (catalog models carry no `compat`, and the resolver applies the Fable / Mythos /
 * Opus 5.5 forced-choice default), never `model.compat` directly.
 */
export function supportsNamedToolChoice(model: Model<Api> | undefined): boolean {
	switch (model?.api) {
		case "anthropic-messages": {
			const compat = getAnthropicCompat(model as Model<"anthropic-messages">);
			return compat.supportsToolChoice !== false && compat.supportsForcedToolChoice !== false;
		}
		case "openai-responses":
		case "openai-completions":
			return true;
		default:
			return false;
	}
}

/** Wire shape of a `tool_choice` that forces `toolName`, or `undefined` for an unsupported api. */
export function namedToolChoicePayload(api: Api | undefined, toolName: string): Record<string, unknown> | undefined {
	switch (api) {
		case "anthropic-messages":
			return { type: "tool", name: toolName };
		case "openai-responses":
			return { type: "function", name: toolName };
		case "openai-completions":
			return { type: "function", function: { name: toolName } };
		default:
			return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function declaresTool(tools: unknown, toolName: string): boolean {
	return (
		Array.isArray(tools) &&
		tools.some(
			(tool) =>
				isRecord(tool) && (tool.name === toolName || (isRecord(tool.function) && tool.function.name === toolName)),
		)
	);
}

/**
 * The payload with a forced `todo` tool_choice, or `undefined` to leave it untouched: the
 * request must declare `todo`, carry no tool_choice of its own, and (Anthropic) not run
 * extended thinking, which rejects any forced tool use.
 */
export function withForcedTodoChoice(payload: unknown, model: Model<Api> | undefined): unknown {
	if (!supportsNamedToolChoice(model)) return undefined;
	const toolChoice = namedToolChoicePayload(model?.api, "todo");
	if (!toolChoice || !isRecord(payload) || payload.tool_choice !== undefined) return undefined;
	if (!declaresTool(payload.tools, "todo")) return undefined;
	const thinking = isRecord(payload.thinking) ? payload.thinking.type : undefined;
	if (model?.api === "anthropic-messages" && (thinking === "enabled" || thinking === "adaptive")) return undefined;
	return { ...payload, tool_choice: toolChoice };
}
