import { sanitizeTerminalLabel, visibleWidth } from "@code-yeongyu/senpi";
import { highlightedCode } from "./code-preview.ts";
import { leadsWithHeadline, liveHeadline } from "./live-headline.ts";
import {
	appendLines,
	assertNever,
	LIVE_RENDER_TICK_MS,
	type PrefixStyle,
	previewText,
	type RenderEnvironment,
	renderPrefixed,
	type StatusPresentation,
	spinner,
	style,
} from "./render-blocks.ts";
import { formatThroughputBadge, renderStatusEvents } from "./render-status.ts";
import { formatRuntimeBadge } from "./runtime-label.ts";
import { formatDuration } from "./tool-widgets.ts";
import type { EvalCellResult, EvalToolDetails } from "./types.ts";

type CellStatus = EvalCellResult["status"];
export type CellThroughput = { readonly calls: number; readonly wallDurationMs: number | undefined };
export type CellBadges = {
	readonly reset: boolean;
	readonly timeout: number | undefined;
	readonly throughput: CellThroughput | undefined;
	/** The call lane still streaming its arguments: the header names the state instead of "running". */
	readonly streaming?: boolean;
};

export const LIVE_LINE_PREFIX: PrefixStyle = { prefix: "╶─ ", continuation: "   ", color: "borderAccent" };
const FRAME_HEADER_PREFIX: PrefixStyle = { prefix: "╭─ ", continuation: "│  ", color: "borderAccent" };
const FRAME_INNER_PREFIX: PrefixStyle = { prefix: "│ ", continuation: "│ ", color: "borderMuted" };
const FRAME_SECTION_PREFIX: PrefixStyle = { prefix: "├─ ", continuation: "│  ", color: "dim" };

export const LIVE_CODE_WINDOW_LINES = 6;
// The live block's total height never changes: header + 6 body rows + border. When output or
// status events exist, they take a fixed tail section and the code window shrinks inside the
// same total (review MEDIUM-2): 6 code rows alone, or 3 code + 3 tail rows.
const LIVE_BODY_ROWS = 6;
const LIVE_TAIL_ROWS = 3;

export function isLiveCellStatus(status: CellStatus): boolean {
	return status === "pending" || status === "running";
}

export function hasLiveCell(details: EvalToolDetails | undefined): boolean {
	return (details?.cells ?? []).some((cell) => isLiveCellStatus(cell.status) && cell.startedAt !== undefined);
}

export function cellPresentation(status: CellStatus, spinnerFrame: number | undefined): StatusPresentation {
	switch (status) {
		case "pending":
			return { label: "pending", icon: "○", color: "muted" };
		case "queued":
			return { label: "queued", icon: "○", color: "muted" };
		case "running":
			return { label: "running", icon: spinner(spinnerFrame), color: "warning" };
		case "detached":
			return { label: "detached", icon: "↗", color: "warning" };
		case "complete":
			return { label: "done", icon: "✓", color: "success" };
		case "error":
			return { label: "error", icon: "✗", color: "error" };
		case "cancelled":
			return { label: "cancelled", icon: "×", color: "error" };
		default:
			return assertNever(status);
	}
}

// A running cell only receives updates on output/status events, so a stored duration
// freezes between them. Non-terminal cells therefore derive elapsed time from the
// render-time clock; terminal cells keep their settled duration verbatim.
export function cellElapsedMs(cell: EvalCellResult, environment: RenderEnvironment): number | undefined {
	if (!isLiveCellStatus(cell.status) || cell.startedAt === undefined) return cell.durationMs;
	return Math.max(0, environment.now - cell.startedAt);
}

// An in-progress row leads with what the cell is doing (senpi#2802). Collapsed, the whole row
// (icon, headline and every badge) always fits one visual line: lower-priority segments are
// dropped first and the headline is cut last, never below its floor (senpi#2933 review HIGH-1).
// The budget is width - 3 because the frame renders the header through renderPrefixed's "╭─ ".
export function headlined(
	icon: string,
	summary: string | undefined,
	code: string | undefined,
	rest: string,
	environment: RenderEnvironment,
): string {
	if (environment.expanded) return `${icon} ${liveHeadline(summary, code, undefined)} · ${rest}`;
	return fitOneLine(icon, liveHeadline(summary, code, undefined), rest, Math.max(1, environment.width - 3));
}

function fitOneLine(icon: string, headline: string, rest: string, width: number): string {
	const lead = `${icon} `;
	const middle = " · ";
	const line = (text: string) => `${lead}${text}${middle}${rest}`;
	if (visibleWidth(line(headline)) <= width) return line(headline);
	// Drop the lowest-priority tail segments of rest (reset/timeout, then elapsed, then badges)
	// until the headline's floor fits; the headline itself is shortened last, never emptied.
	let keptRest = rest;
	for (;;) {
		const cut = keptRest.lastIndexOf(middle);
		if (cut <= 0) break;
		keptRest = keptRest.slice(0, cut);
		if (visibleWidth(`${lead}${headline}${middle}${keptRest}`) <= width)
			return `${lead}${headline}${middle}${keptRest}`;
	}
	const budget = Math.max(4, width - visibleWidth(`${lead}${middle}${keptRest}`) - 1);
	const shortened = visibleWidth(headline) <= budget ? headline : `${cellPrefixText(headline, budget - 1)}…`;
	return `${lead}${shortened}${middle}${keptRest}`;
}

function cellPrefixText(text: string, cells: number): string {
	let kept = "";
	let used = 0;
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
		const width = visibleWidth(segment);
		if (used + width > cells) break;
		kept += segment;
		used += width;
	}
	return kept;
}

export function cellHeader(cell: EvalCellResult, environment: RenderEnvironment, badges: CellBadges): string {
	const spinnerFrame =
		environment.spinnerFrame ?? Math.floor((cellElapsedMs(cell, environment) ?? 0) / LIVE_RENDER_TICK_MS);
	const presentation =
		badges.streaming === true
			? { label: "streaming", icon: spinner(spinnerFrame), color: "warning" as const }
			: cellPresentation(cell.status, spinnerFrame);
	const runtimeBadge = cell.runtime === undefined ? "" : ` (${formatRuntimeBadge(cell.language, cell.runtime)})`;
	const base = leadsWithHeadline(cell.status)
		? `eval ${cell.language}${runtimeBadge} ${presentation.label}`
		: `eval ${cell.language}${runtimeBadge} ${presentation.label} ${presentation.icon}`;
	const segments: string[] = [];
	if (cell.queuedBehind !== undefined && cell.queuedBehind.length > 0)
		segments.push(`queued behind ${cell.queuedBehind.map(sanitizeTerminalLabel).join(", ")}`);
	else if (cell.queuedBehind !== undefined && cell.status === "queued")
		segments.push(`waiting for the ${cell.language} kernel to be ready`);
	const throughputBadge = badges.throughput === undefined ? undefined : formatThroughputBadge(badges.throughput);
	if (throughputBadge !== undefined) segments.push(throughputBadge);
	const elapsedMs = badges.throughput?.wallDurationMs ?? cellElapsedMs(cell, environment);
	if (elapsedMs !== undefined) segments.push(formatDuration(elapsedMs));
	if (badges.reset) segments.push("reset");
	if (badges.timeout !== undefined) segments.push(`timeout ${badges.timeout}s`);
	const header = leadsWithHeadline(cell.status)
		? headlined(presentation.icon, cell.summary, cell.code, joinSegments(base, segments), environment)
		: joinSegments(base, segments);
	return style(environment.theme, presentation.color, header);
}

function joinSegments(base: string, segments: readonly string[]): string {
	return segments.length === 0 ? base : `${base} · ${segments.join(" · ")}`;
}

// A live row is a framed block of constant total height: header + LIVE_BODY_ROWS body rows +
// border, whether or not output or status events have arrived. New code lines scroll the code
// window upward inside its share; the hidden prefix folds into one "N earlier code lines" row
// counted inside the share, so the block never grows the transcript.
export function renderLiveCellFrame(
	cell: EvalCellResult,
	environment: RenderEnvironment,
	badges: CellBadges,
): string[] {
	const lines = renderPrefixed(cellHeader(cell, environment, badges), environment, FRAME_HEADER_PREFIX);
	const hasOutput = cell.output.trimEnd().length > 0;
	const hasStatus = (cell.statusEvents ?? []).some((event) => event.op !== "agent");
	const tail: string[] = [];
	if (hasOutput) appendLines(tail, cellOutputSection(cell, environment, 0, LIVE_TAIL_ROWS));
	else if (hasStatus) appendLines(tail, cellStatusSection(cell, environment, LIVE_TAIL_ROWS));
	// The sections fit themselves inside the tail budget with exact omission markers, so the
	// block's total never changes and no count is understated (review MEDIUM-2, HIGH-2).
	const codeRows = tail.length === 0 ? LIVE_BODY_ROWS : LIVE_BODY_ROWS - LIVE_TAIL_ROWS;
	appendLines(lines, liveCodeWindow(cell, environment, codeRows));
	appendLines(lines, tail);
	lines.push(style(environment.theme, "borderMuted", "╰─"));
	return lines;
}

function liveCodeWindow(cell: EvalCellResult, environment: RenderEnvironment, windowRows: number): string[] {
	const innerWidth = Math.max(1, environment.width - 2);
	// Streamed code is not yet trusted input: a hostile or half-arrived chunk can carry escape and
	// control characters, and the collapsed row must stay inert in the terminal (senpi#2839).
	const code = highlightedCode(sanitizeCellCode(cell.code), cell.language, environment.theme, environment.repaint);
	// The marker counts SOURCE lines (LOW-4); the shown rows stay visual lines so wrapping never
	// changes the height. When the source overflows, the marker takes one of the window's rows.
	const sourceLines = code.split("\n").length;
	const budget = sourceLines > windowRows ? windowRows - 1 : windowRows;
	const preview = previewText(code, budget, innerWidth);
	const skippedSources = Math.max(0, sourceLines - preview.lines.length);
	const windowLines: string[] = [];
	if (preview.skipped > 0)
		appendLines(
			windowLines,
			renderPrefixed(`${skippedSources} earlier code lines`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "muted",
			}),
		);
	for (const line of preview.lines) appendLines(windowLines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
	while (windowLines.length < windowRows) windowLines.push(style(environment.theme, "borderMuted", "│ "));
	return windowLines.slice(0, windowRows);
}

function sanitizeCellCode(code: string): string {
	return code
		.split("\n")
		.map((line) => sanitizeTerminalLabel(line))
		.join("\n");
}

// The window's "N earlier code lines" marker counts SOURCE lines (LOW-4), while the shown rows
// stay visual lines so wrapping never changes the height.

export function cellOutputSection(
	cell: EvalCellResult,
	environment: RenderEnvironment,
	maxLines: number,
	rowBudget?: number,
): string[] {
	const output = cell.output.trimEnd();
	if (output.length === 0) return [];
	const lines = renderPrefixed("output", environment, FRAME_SECTION_PREFIX);
	const outputColor = cell.status === "error" ? "error" : "toolOutput";
	const styledOutput = output
		.split("\n")
		.map((line) => style(environment.theme, outputColor, line))
		.join("\n");
	const innerWidth = Math.max(1, environment.width - 2);
	if (rowBudget !== undefined) {
		// Fit the whole section (header, omission marker, lines) inside the row budget; the
		// marker counts every line not shown, exactly (review MEDIUM-2).
		const preview = previewText(styledOutput, Math.max(1, rowBudget - 1), innerWidth);
		if (preview.skipped === 0) {
			for (const line of preview.lines) appendLines(lines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
			return lines;
		}
		const kept = preview.lines.slice(-Math.max(0, rowBudget - 2));
		const omitted = preview.skipped + preview.lines.length - kept.length;
		appendLines(
			lines,
			renderPrefixed(`${omitted} earlier output lines`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "muted",
			}),
		);
		for (const line of kept) appendLines(lines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
		return lines;
	}
	const outputPreview = previewText(styledOutput, maxLines, innerWidth);
	if (outputPreview.skipped > 0)
		appendLines(
			lines,
			renderPrefixed(`${outputPreview.skipped} earlier output lines`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "muted",
			}),
		);
	for (const line of outputPreview.lines) appendLines(lines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
	return lines;
}

export function cellStatusSection(cell: EvalCellResult, environment: RenderEnvironment, rowBudget?: number): string[] {
	const statusEvents = (cell.statusEvents ?? []).filter((event) => event.op !== "agent");
	if (statusEvents.length === 0) return [];
	const lines = renderPrefixed("status", environment, FRAME_SECTION_PREFIX);
	if (rowBudget === undefined) {
		for (const line of renderStatusEvents(statusEvents, environment))
			appendLines(lines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
		return lines;
	}
	// Fit the whole section (header, omission marker, event rows) inside the row budget, folding
	// the stored bound marker and the sliced events into one exact omission count (review HIGH-2).
	const first = statusEvents[0];
	const omittedByBound = first?.op === "status-events-omitted" && typeof first.count === "number" ? first.count : 0;
	const visible = omittedByBound > 0 ? statusEvents.slice(1) : statusEvents;
	let retained = visible.slice(-Math.max(0, rowBudget - 1));
	let skipped = visible.length - retained.length + omittedByBound;
	if (skipped > 0) {
		retained = visible.slice(-Math.max(0, rowBudget - 2));
		skipped = visible.length - retained.length + omittedByBound;
	}
	if (skipped > 0)
		appendLines(
			lines,
			renderPrefixed(`├ … ${skipped} earlier status events`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "dim",
			}),
		);
	for (const line of renderStatusEvents(retained, { ...environment, expanded: true }))
		appendLines(lines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
	return lines;
}

export { FRAME_HEADER_PREFIX, FRAME_INNER_PREFIX, FRAME_SECTION_PREFIX };
