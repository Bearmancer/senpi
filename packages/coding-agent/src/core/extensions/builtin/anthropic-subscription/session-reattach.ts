import type { AnthropicSubscriptionAuthLane } from "./options.ts";
import type { Options, SessionMessage } from "./sdk-boundary.ts";
import { getSdkBoundary, loadClaudeAgentSdk } from "./sdk-boundary.ts";
import { logContinuityEvent } from "./session-observability.ts";
import { type AnthropicSubscriptionSessionEntry, closeSession, getOrCreateSession } from "./session-registry.ts";
import { recordSyncedStream } from "./session-sync.ts";

export type ContinuityBinding = {
	senpiSessionId: string;
	sdkSessionId: string;
	sentCount: number;
	sentHashes: readonly string[];
	sentPrefixHash?: string;
	/**
	 * False while the SDK has not yet acknowledged this session id (no init and
	 * no replay echo): continuity must never resume or fork such an id.
	 */
	sdkSessionIdConfirmed?: boolean;
	lastAssistantUuid: string | null;
	accountName: string;
	modelId: string;
	systemPromptHash: string;
	toolsetHash: string;
	/** Assistant boundaries kept as entries so a later fork still has a resume point. */
	assistantUuidByIndex?: readonly (readonly [number, string])[];
	/**
	 * Digest of the FULL sent stream an attempt pushed but never got answered
	 * (stream-start timeout abort/failure). Purely in-memory: it lets the SAME
	 * turn's retry fork at the pre-turn boundary instead of re-appending its user
	 * message to a lineage that already carries it. Never persisted — the sidecar
	 * schema is fixed at schemaVersion 1 and restart retries are out of scope.
	 */
	unansweredTurnDigest?: string;
};

export type ReattachInput = {
	binding: ContinuityBinding;
	options: Options;
	atUuid?: string;
	signal?: AbortSignal;
};

const bindings = new Map<string, ContinuityBinding>();

export type AbortOutcome = "keep" | "reattach";

function cloneBinding(binding: ContinuityBinding): ContinuityBinding {
	return {
		...binding,
		sentHashes: [...binding.sentHashes],
		assistantUuidByIndex: binding.assistantUuidByIndex?.map(([index, uuid]) => [index, uuid]),
	};
}

export function evaluateAbortOutcome(receipt: unknown): AbortOutcome {
	if (!receipt || typeof receipt !== "object") return "reattach";
	const queued = (receipt as { still_queued?: unknown }).still_queued;
	return Array.isArray(queued) && queued.length === 0 ? "keep" : "reattach";
}

export function rememberBinding(binding: ContinuityBinding): void {
	bindings.set(binding.senpiSessionId, cloneBinding(binding));
}

export function getBinding(senpiSessionId: string): ContinuityBinding | undefined {
	const binding = bindings.get(senpiSessionId);
	return binding ? cloneBinding(binding) : undefined;
}

export function forgetBinding(senpiSessionId: string): void {
	bindings.delete(senpiSessionId);
}

/**
 * Reason the newest ledger record invalidated this session's binding. Held next
 * to the binding it replaced so the next continuity decision can name the real
 * cause instead of the no-record default: a restart re-reads it from the branch
 * (session-registry-wiring), and a committed turn retires it with the marker.
 */
const bindingInvalidations = new Map<string, string>();

export function rememberBindingInvalidation(senpiSessionId: string, reason: string | undefined): void {
	if (reason === undefined) bindingInvalidations.delete(senpiSessionId);
	else bindingInvalidations.set(senpiSessionId, reason);
}

export function bindingInvalidationReason(senpiSessionId: string): string | undefined {
	return bindingInvalidations.get(senpiSessionId);
}

export function bindingFromEntry(
	entry: Pick<
		AnthropicSubscriptionSessionEntry,
		| "senpiSessionId"
		| "sdkSessionId"
		| "sentCount"
		| "accountName"
		| "modelId"
		| "systemPromptHash"
		| "toolsetHash"
		| "assistantUuidByIndex"
		| "sdkSessionIdConfirmed"
	>,
	sentHashes: readonly string[],
): ContinuityBinding {
	return {
		senpiSessionId: entry.senpiSessionId,
		sdkSessionId: entry.sdkSessionId,
		sdkSessionIdConfirmed: entry.sdkSessionIdConfirmed,
		sentCount: entry.sentCount,
		sentHashes: [...sentHashes],
		lastAssistantUuid: entry.assistantUuidByIndex.get(entry.sentCount) ?? null,
		assistantUuidByIndex: [...entry.assistantUuidByIndex.entries()],
		accountName: entry.accountName,
		modelId: entry.modelId,
		systemPromptHash: entry.systemPromptHash,
		toolsetHash: entry.toolsetHash,
	};
}

export async function verifyRestoredTranscript(
	binding: ContinuityBinding,
	cwd: string,
	authLane: AnthropicSubscriptionAuthLane,
): Promise<boolean> {
	if (authLane === "config-dir") return false;
	let messages: SessionMessage[];
	try {
		messages = await getSdkBoundary().getSessionMessages(binding.sdkSessionId, { dir: cwd });
	} catch (error) {
		if (error instanceof Error) return false;
		throw error;
	}
	if (messages.length === 0 || messages.some((message) => message.session_id !== binding.sdkSessionId)) {
		return false;
	}
	const isTopLevelAssistant = (message: SessionMessage, uuid: string): boolean =>
		message.type === "assistant" && message.uuid === uuid && message.parent_tool_use_id === null;
	if (binding.lastAssistantUuid === null) {
		// The newest assistant was never mapped (Claude Code rejected its boundary, senpi#1958), so the
		// binding can only be proven by the newest boundary that WAS mapped: it must be a top-level assistant
		// of this transcript. The turns after it are the binding's own unmapped ones, so a user frame there is
		// expected and is not an orphan. With no mapped boundary at all, nothing in the transcript proves the
		// binding, so it is never resumed unchecked (senpi#2858): the session is rebuilt instead.
		const proof = newestMappedBoundary(binding);
		return proof !== undefined && messages.some((message) => isTopLevelAssistant(message, proof));
	}
	const anchorUuid = binding.lastAssistantUuid;
	const anchorIndex = messages.findIndex((message) => isTopLevelAssistant(message, anchorUuid));
	if (anchorIndex < 0) return false;
	// A top-level user frame after the anchored assistant is a turn the SDK transcript already
	// holds but the ledger never committed: the process died between pushing the message and
	// the assistant's commit. A plain resume from the anchor would append that user message a
	// second time (the in-memory retry checkpoint that forks past such an orphan is never
	// persisted), so the restored binding fails closed until a fork at the anchor exists
	// (senpi#1973). Only the count is logged, never the content.
	const orphanUserMessages = messages
		.slice(anchorIndex + 1)
		.filter((message) => message.type === "user" && message.parent_tool_use_id === null).length;
	if (orphanUserMessages > 0) {
		logContinuityEvent("claude_sdk_oauth_restored_transcript_orphan_tail", { orphanUserMessages });
		return false;
	}
	return true;
}

/** The uuid of the newest mapped assistant boundary at or below the binding's sent count (index >= 1). */
function newestMappedBoundary(binding: ContinuityBinding): string | undefined {
	let newest: readonly [number, string] | undefined;
	for (const boundary of binding.assistantUuidByIndex ?? []) {
		const [index] = boundary;
		if (index >= 1 && index <= binding.sentCount && (newest === undefined || index > newest[0])) newest = boundary;
	}
	return newest?.[1];
}

async function awaitInitialization(entry: AnthropicSubscriptionSessionEntry, signal?: AbortSignal): Promise<void> {
	const initialize = entry.query.initializationResult;
	if (!initialize) return;
	if (!signal) {
		await initialize.call(entry.query);
		return;
	}
	let rejectAborted: (reason?: unknown) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		rejectAborted = reject;
	});
	const onAbort = (): void => {
		closeSession(entry.senpiSessionId, "resume_initialization_aborted");
		rejectAborted(new Error("Anthropic Subscription reattach aborted"));
	};
	if (signal.aborted) {
		onAbort();
	} else {
		signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		await Promise.race([initialize.call(entry.query), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * A new query is not a new session: `resume` re-attaches to the existing lineage.
 * `sessionId` must stay absent unless forking, because the SDK rejects the pair
 * (sdk.d.ts:1805-1808) and would otherwise silently start an unrelated session.
 */
export async function reattachSession(input: ReattachInput): Promise<AnthropicSubscriptionSessionEntry> {
	// getOrCreateSession() reaches the synchronous SDK `query` through the
	// session-registry boundary - see sdk-boundary.lazy.ts.
	await loadClaudeAgentSdk();
	const { binding, atUuid } = input;
	closeSession(binding.senpiSessionId, "reattach");
	const entry = getOrCreateSession({
		senpiSessionId: binding.senpiSessionId,
		accountName: binding.accountName,
		modelId: binding.modelId,
		systemPromptHash: binding.systemPromptHash,
		toolsetHash: binding.toolsetHash,
		options: input.options,
		resume: atUuid ? { sdkSessionId: binding.sdkSessionId, atUuid } : { sdkSessionId: binding.sdkSessionId },
	});

	try {
		await awaitInitialization(entry, input.signal);
	} catch (error) {
		closeSession(binding.senpiSessionId, "resume_initialization_failed");
		throw error;
	}

	recordSyncedStream(entry, binding.sentHashes);
	for (const [index, uuid] of binding.assistantUuidByIndex ?? []) entry.assistantUuidByIndex.set(index, uuid);
	if (binding.lastAssistantUuid) entry.assistantUuidByIndex.set(binding.sentCount, binding.lastAssistantUuid);
	rememberBinding({ ...binding, sdkSessionId: entry.sdkSessionId });
	return entry;
}
