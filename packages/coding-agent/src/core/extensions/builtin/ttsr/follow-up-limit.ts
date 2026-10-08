import { TTSR_INJECTION_CUSTOM_TYPE } from "./types.ts";

export const MAX_FOLLOW_UPS_PER_USER_MESSAGE = 1;
export const MAX_FOLLOW_UPS_PER_WINDOW = 3;
export const FOLLOW_UP_WINDOW_MS = 60_000;

export const TTSR_LOOP_STOPPED_ENTRY_TYPE = "ttsr-loop-stopped";
export const TTSR_LOOP_STOPPED_EVENT = "ttsr:loop-stopped";
export const TTSR_LOOP_STOPPED_NOTICE =
	"A stream rule kept flagging the reply, so no more automatic turns were started. Send a message to continue.";

export type FollowUpStopReason = "per-user-message" | "session-rate";

function isUserMessage(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	if (Reflect.get(entry, "type") !== "message") return false;
	const message: unknown = Reflect.get(entry, "message");
	return typeof message === "object" && message !== null && Reflect.get(message, "role") === "user";
}

function isTtsrFollowUp(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	return (
		Reflect.get(entry, "type") === "custom_message" && Reflect.get(entry, "customType") === TTSR_INJECTION_CUSTOM_TYPE
	);
}

function entryTime(entry: unknown): number | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const timestamp: unknown = Reflect.get(entry, "timestamp");
	if (typeof timestamp === "number") return timestamp;
	if (typeof timestamp === "string") {
		const parsed = Date.parse(timestamp);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

/**
 * Whether another rule-triggered follow-up turn may start. Counts the ttsr nudges already in the
 * session (not in-memory state), so a host that rebuilds the extension between turns is bounded too
 * (senpi#2967).
 */
export function followUpStopReason(entries: readonly unknown[], now: number): FollowUpStopReason | null {
	let sinceUserMessage = 0;
	let inWindow = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (isUserMessage(entry)) break;
		if (!isTtsrFollowUp(entry)) continue;
		sinceUserMessage += 1;
	}
	for (const entry of entries) {
		if (!isTtsrFollowUp(entry)) continue;
		const at = entryTime(entry);
		if (at !== undefined && now - at < FOLLOW_UP_WINDOW_MS) inWindow += 1;
	}
	if (sinceUserMessage >= MAX_FOLLOW_UPS_PER_USER_MESSAGE) return "per-user-message";
	if (inWindow >= MAX_FOLLOW_UPS_PER_WINDOW) return "session-rate";
	return null;
}
