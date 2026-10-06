import { type EvalCellResult, type EvalLanguage, evalLanguageOrder } from "./types.ts";

const HEADLINED_STATUSES: ReadonlySet<EvalCellResult["status"]> = new Set(["pending", "queued", "running", "detached"]);

/** A collapsed headline never wraps the frame; this floor keeps it readable in narrow terminals. */
const MIN_HEADLINE_CHARS = 24;

export function leadsWithHeadline(status: EvalCellResult["status"]): boolean {
	return HEADLINED_STATUSES.has(status);
}

/**
 * What an in-progress cell is doing, in one line: its summary, or else the first non-blank line of its code (the
 * oh-my-pi fallback), or an ellipsis while the arguments are still streaming in. Collapsed rows cut it to
 * `maxChars`, so the headline stays one line.
 */
export function liveHeadline(
	summary: string | undefined,
	code: string | undefined,
	maxChars: number | undefined,
): string {
	const text = summary?.trim() || firstCodeLine(code) || "…";
	const limit = maxChars === undefined ? undefined : Math.max(MIN_HEADLINE_CHARS, maxChars);
	if (limit === undefined || [...text].length <= limit) return text;
	return `${[...text].slice(0, limit - 1).join("")}…`;
}

export function knownLanguage(language: unknown): EvalLanguage | undefined {
	return evalLanguageOrder.find((known) => known === language);
}

function firstCodeLine(code: string | undefined): string | undefined {
	return code
		?.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}
