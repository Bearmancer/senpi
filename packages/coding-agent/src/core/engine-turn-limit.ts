export const MAX_ENGINE_TURNS_PER_USER_INPUT = 150;
export const MAX_TOOL_FREE_ENGINE_TURNS_PER_WINDOW = 12;
export const ENGINE_TURN_WINDOW_MS = 60_000;

export const ENGINE_TURN_LIMIT_ENTRY_TYPE = "engine-turn-limit";
export const ENGINE_TURN_LIMIT_EVENT = "engine:turn-limit";

export type EngineTurnStopReason = "per-user-input" | "tool-free-rate";

export interface EngineTurnLimits {
	readonly maxPerUserInput: number;
	readonly maxToolFreePerMinute: number;
}

export interface EngineTurnStop {
	readonly reason: EngineTurnStopReason;
	readonly sinceUserInput: number;
	readonly toolFreeInWindow: number;
}

export function engineTurnLimitNotice(stop: EngineTurnStop): string {
	return stop.reason === "per-user-input"
		? `Paused: the agent started ${stop.sinceUserInput} turns on its own since your last message. Send any message to continue.`
		: `Paused: the agent started ${stop.toolFreeInWindow} turns on its own in the last minute without doing any work. Send any message to continue.`;
}

function messageOf(entry: unknown): Record<string, unknown> | undefined {
	if (typeof entry !== "object" || entry === null || Reflect.get(entry, "type") !== "message") return undefined;
	const message: unknown = Reflect.get(entry, "message");
	return typeof message === "object" && message !== null ? (message as Record<string, unknown>) : undefined;
}

function isUserMessage(entry: unknown): boolean {
	return messageOf(entry)?.role === "user";
}

function isEngineTurnStart(entry: unknown): boolean {
	return typeof entry === "object" && entry !== null && Reflect.get(entry, "type") === "custom_message";
}

function callsATool(entry: unknown): boolean {
	const message = messageOf(entry);
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return false;
	return message.content.some(
		(block) => typeof block === "object" && block !== null && Reflect.get(block, "type") === "toolCall",
	);
}

function entryTime(entry: unknown): number | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const timestamp: unknown = Reflect.get(entry, "timestamp");
	if (typeof timestamp === "number") return timestamp;
	if (typeof timestamp !== "string") return undefined;
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Whether one more engine-originated turn (an extension's `sendMessage` with `triggerTurn`, from any source:
 * a stream-rule nudge, a goal continuation, ...) may start without a new user message. Read from the session
 * entries so a host that rebuilds extensions or reopens the session between turns is bounded too. The rate
 * breaker counts only engine turns whose reply called no tool: measured goal runs never exceed it, while every
 * observed runaway is that shape (senpi#2967).
 */
export function engineTurnStop(
	entries: readonly unknown[],
	now: number,
	limits: EngineTurnLimits,
): EngineTurnStop | null {
	let sinceUserInput = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (isUserMessage(entry)) break;
		if (isEngineTurnStart(entry)) sinceUserInput += 1;
	}
	let toolFreeInWindow = 0;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!isEngineTurnStart(entry)) continue;
		const at = entryTime(entry);
		if (at === undefined || now - at >= ENGINE_TURN_WINDOW_MS) continue;
		let toolUsed = false;
		for (let next = index + 1; next < entries.length; next++) {
			if (isEngineTurnStart(entries[next]) || isUserMessage(entries[next])) break;
			if (callsATool(entries[next])) {
				toolUsed = true;
				break;
			}
		}
		if (!toolUsed) toolFreeInWindow += 1;
	}
	if (sinceUserInput >= limits.maxPerUserInput) return { reason: "per-user-input", sinceUserInput, toolFreeInWindow };
	if (toolFreeInWindow >= limits.maxToolFreePerMinute)
		return { reason: "tool-free-rate", sinceUserInput, toolFreeInWindow };
	return null;
}
