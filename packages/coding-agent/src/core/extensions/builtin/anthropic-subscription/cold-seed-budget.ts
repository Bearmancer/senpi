import {
	type Api,
	type AssistantMessage,
	type AssistantMessageDiagnostic,
	type Context,
	isContextOverflow,
	type Model,
} from "@earendil-works/pi-ai";
import { serializedPayloadBytes } from "./prompt-directive-dedupe.ts";
import type { ContentBlockParam } from "./sdk-boundary.ts";

/**
 * Marks an assistant turn that failed because a cold-seed (flatten/bootstrap)
 * request did not fit the model window. A cold-seed re-sends senpi's own
 * history as ONE user message, which the Claude Agent SDK cannot compact, so
 * the compaction lane policy reads this marker to let senpi own the recovery.
 * It is persisted with the message, so a restarted session still recovers.
 */
export const COLD_SEED_OVERFLOW_DIAGNOSTIC = "claude_sdk_oauth_cold_seed_overflow";

/**
 * Claude's tokenizer spends at least one token per ~4 UTF-8 bytes on realistic
 * prose, code, JSON and CJK text, so bytes/4 under-counts rather than over-counts:
 * a request this estimate already places over the window cannot be accepted.
 * Images and Claude Code's own preamble are left out for the same reason.
 */
const UTF8_BYTES_PER_TOKEN_FLOOR = 4;

export class ColdSeedOverflowError extends Error {
	readonly estimatedTokens: number;
	readonly contextWindow: number;

	constructor(estimatedTokens: number, contextWindow: number) {
		// pi-ai's OVERFLOW_PATTERNS matches this wording, so overflow recovery takes it like an API rejection.
		super(
			`The conversation is too long to resend (about ${estimatedTokens} tokens, limit ${contextWindow}). Compacting it and retrying.`,
		);
		this.name = "ColdSeedOverflowError";
		this.estimatedTokens = estimatedTokens;
		this.contextWindow = contextWindow;
	}
}

export function estimateColdSeedTokens(
	context: Pick<Context, "systemPrompt" | "tools">,
	blocks: readonly ContentBlockParam[],
): number {
	const fixedBytes =
		Buffer.byteLength(context.systemPrompt ?? "", "utf8") +
		Buffer.byteLength(JSON.stringify(context.tools ?? []), "utf8");
	return Math.ceil((fixedBytes + serializedPayloadBytes(blocks)) / UTF8_BYTES_PER_TOKEN_FLOOR);
}

export function coldSeedOverflow(
	model: Model<Api>,
	context: Pick<Context, "systemPrompt" | "tools">,
	blocks: readonly ContentBlockParam[],
): ColdSeedOverflowError | undefined {
	if (!(model.contextWindow > 0)) return undefined;
	const estimatedTokens = estimateColdSeedTokens(context, blocks);
	return estimatedTokens > model.contextWindow
		? new ColdSeedOverflowError(estimatedTokens, model.contextWindow)
		: undefined;
}

export function markColdSeedOverflow(output: AssistantMessage, model: Model<Api>, coldSeedAttempt: boolean): void {
	if (!coldSeedAttempt || output.stopReason !== "error" || !isContextOverflow(output, model.contextWindow)) return;
	output.diagnostics = [
		...(output.diagnostics ?? []),
		{ type: COLD_SEED_OVERFLOW_DIAGNOSTIC, timestamp: Date.now() } satisfies AssistantMessageDiagnostic,
	];
}

export function isColdSeedOverflowMessage(message: {
	role: string;
	diagnostics?: readonly AssistantMessageDiagnostic[];
}): boolean {
	return (
		message.role === "assistant" &&
		(message.diagnostics ?? []).some((diagnostic) => diagnostic.type === COLD_SEED_OVERFLOW_DIAGNOSTIC)
	);
}
