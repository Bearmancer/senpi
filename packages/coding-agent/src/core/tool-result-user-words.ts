import type { Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * Words the user typed that a tool result carries in `details.userWords` instead of its content.
 * A model trained to distrust tool results may ignore user text inside one (senpi#2920), so each
 * request delivers them as a user turn after the tool results, every word after its own label.
 */
export interface ToolResultUserWord {
	readonly label: string;
	readonly text: string;
}

function isUserWord(value: unknown): value is ToolResultUserWord {
	return (
		typeof value === "object" &&
		value !== null &&
		"label" in value &&
		typeof value.label === "string" &&
		"text" in value &&
		typeof value.text === "string"
	);
}

export function toolResultUserWords(
	message: Pick<ToolResultMessage, "details"> | { details: unknown },
): ToolResultUserWord[] {
	const details: unknown = message.details;
	if (typeof details !== "object" || details === null || !("userWords" in details)) return [];
	return Array.isArray(details.userWords) ? details.userWords.filter(isUserWord) : [];
}

/** The label block a reference names, then the words, for each word in order. */
export function userWordBlocks(words: readonly ToolResultUserWord[]): TextContent[] {
	return words.flatMap((word): TextContent[] => [
		{ type: "text", text: `[${word.label}]` },
		{ type: "text", text: word.text },
	]);
}

/**
 * Inserts one user message after each contiguous run of tool results whose details carry user
 * words. It is derived only from persisted tool results, so live requests, resumed sessions and
 * compaction all see the same messages, and no queue operation can drop them.
 */
export function appendToolResultUserWords(messages: Message[]): Message[] {
	if (!messages.some((message) => message.role === "toolResult" && toolResultUserWords(message).length > 0)) {
		return messages;
	}
	const result: Message[] = [];
	let pending: TextContent[] = [];
	let timestamp = 0;
	const flush = (next: Message | undefined) => {
		if (pending.length > 0 && !startsWithBlocks(next, pending))
			result.push({ role: "user", content: pending, timestamp });
		pending = [];
	};
	for (const message of messages) {
		if (message.role !== "toolResult") flush(message);
		result.push(message);
		if (message.role !== "toolResult") continue;
		const blocks = userWordBlocks(toolResultUserWords(message));
		if (blocks.length === 0) continue;
		pending.push(...blocks);
		timestamp = message.timestamp;
	}
	flush(undefined);
	return result;
}

/** Already converted output carries the word message right after the run; converting again keeps one. */
function startsWithBlocks(message: Message | undefined, blocks: readonly TextContent[]): boolean {
	if (message?.role !== "user" || typeof message.content === "string") return false;
	const content = message.content;
	return blocks.every((block, index) => {
		const candidate = content[index];
		return candidate?.type === "text" && candidate.text === block.text;
	});
}
