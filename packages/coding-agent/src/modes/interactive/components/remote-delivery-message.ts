import type { TextContent } from "@earendil-works/pi-ai";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type MessageRenderer, SESSION_CONTROL_DELIVERY_TYPE } from "../../../core/extensions/types.ts";
import { getMarkdownTheme } from "../theme/theme.ts";

/**
 * A message another session delivered renders as its own provenance block - never as the user's
 * own input, so a reader always sees which text came from outside this terminal.
 */
export const renderRemoteDelivery: MessageRenderer = (message, _options, theme) => {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const label = theme.fg("customMessageLabel", theme.bold("remote message"));
	box.addChild(new Text(`${label}${theme.fg("dim", ` · delivery ${deliveryIdOf(message.details)}`)}`, 0, 0));
	box.addChild(new Spacer(1));
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part): part is TextContent => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	box.addChild(new Markdown(text, 0, 0, getMarkdownTheme(), { color: (line) => theme.fg("customMessageText", line) }));
	return box;
};

export function builtInMessageRenderer(customType: string): MessageRenderer | undefined {
	return customType === SESSION_CONTROL_DELIVERY_TYPE ? renderRemoteDelivery : undefined;
}

function deliveryIdOf(details: unknown): string {
	if (typeof details !== "object" || details === null || !("delivery_id" in details)) return "unknown";
	return typeof details.delivery_id === "string" ? details.delivery_id : "unknown";
}
