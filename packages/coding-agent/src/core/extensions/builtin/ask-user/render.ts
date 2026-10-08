import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../types.ts";
import { TOOL_NAMES } from "./family.ts";
import { resolveUserTextReferences } from "./format.ts";

export const renderCall: NonNullable<ToolDefinition["renderCall"]> = (args, theme) => {
	const values = typeof args === "object" && args !== null ? args : {};
	const headers =
		"questions" in values && Array.isArray(values.questions)
			? values.questions
					.map((q: unknown) =>
						typeof q === "object" && q !== null && "header" in q ? `[${q.header}]` : "[Question]",
					)
					.join(" ")
			: "Question";
	const wait =
		("waitForAnswer" in values && values.waitForAnswer === true) ||
		("wait_for_answer" in values && values.wait_for_answer === true);
	return new Text(`${theme.fg("toolTitle", headers)} ${wait ? "wait for answer" : "answer later"}`, 0, 0);
};
export const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result) => {
	const details: unknown = result.details;
	let summary = "";
	let userText: string[] = [];
	if (typeof details === "object" && details !== null && "userText" in details && Array.isArray(details.userText))
		userText = details.userText.filter((text): text is string => typeof text === "string");
	if (typeof details === "object" && details !== null && "status" in details) {
		summary = String(details.status);
		if ("answers" in details && typeof details.answers === "object" && details.answers !== null)
			summary += `; ${Object.keys(details.answers).length} answered`;
		if ("unanswered" in details && Array.isArray(details.unanswered))
			summary += `; ${details.unanswered.length} unanswered`;
	}
	return new Text(
		[
			summary,
			...result.content.flatMap((c) => (c.type === "text" ? [resolveUserTextReferences(c.text, userText)] : [])),
		]
			.filter(Boolean)
			.join("\n"),
		0,
		0,
	);
};

/**
 * Renderers for a question card whose tool definition is not resolvable: the tools are registered
 * when the session synchronizes them, so a card streamed while a reload is in flight - or replayed
 * in a session where ask-user is disabled - would otherwise fall back to a raw argument dump.
 */
export function askUserRenderers(toolName: string): Pick<ToolDefinition, "renderCall" | "renderResult"> | undefined {
	return Object.values(TOOL_NAMES).includes(toolName) ? { renderCall, renderResult } : undefined;
}
