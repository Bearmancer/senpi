import type { TextContent } from "@earendil-works/pi-ai";

/**
 * The text content of a user message. Text that arrived as several blocks keeps them while they
 * still spell the final text exactly (joined by a newline); text that an input handler or a
 * template expansion rewrote becomes one block. This keeps a harness label and the user's own
 * words in separate blocks (senpi#2920).
 */
export function userTextContent(text: string, textBlocks?: readonly string[]): TextContent[] {
	if (textBlocks !== undefined && textBlocks.length > 1 && textBlocks.join("\n") === text) {
		return textBlocks.map((block) => ({ type: "text", text: block }));
	}
	return [{ type: "text", text }];
}
