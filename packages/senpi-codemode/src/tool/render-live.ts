import { sanitizeTerminalLabel, truncateToVisualLines, visibleWidth } from "@code-yeongyu/senpi";
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
	// The tail always keeps its full row count (review HIGH-C): a short section is padded, and
	// each section fits itself inside the budget in visual rows with exact omission markers.
	const tail: string[] = [];
	if (hasOutput) appendLines(tail, cellOutputSection(cell, environment, LIVE_TAIL_ROWS, LIVE_TAIL_ROWS));
	else if (hasStatus) appendLines(tail, cellStatusSection(cell, environment, LIVE_TAIL_ROWS));
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
	// Fill from the bottom by VISUAL rows so the newest source line is always fully visible
	// (review HIGH-B); the marker counts hidden SOURCE lines. When the source overflows, the
	// marker takes one of the window's rows.
	const allRows = visualLines(code, innerWidth);
	const totalRows = allRows.length;
	const fits = totalRows <= windowRows;
	const budget = fits ? windowRows : windowRows - 1;
	const kept = allRows.slice(Math.max(0, totalRows - budget));
	const skippedVisual = totalRows - kept.length;
	const hiddenSourceLines = countHiddenSourceLines(code, innerWidth, skippedVisual);
	const windowLines: string[] = [];
	if (!fits)
		appendLines(
			windowLines,
			renderPrefixed(`${hiddenSourceLines} earlier code lines`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "muted",
			}),
		);
	for (const line of kept) appendLines(windowLines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
	while (windowLines.length < windowRows) windowLines.push(style(environment.theme, "borderMuted", "│ "));
	return windowLines;
}

// The source lines whose start lies above the first shown row: walk the code's own lines,
// wrapping each, and count the lines whose visual rows are entirely hidden (review HIGH-B).
function countHiddenSourceLines(code: string, innerWidth: number, skippedVisual: number): number {
	if (skippedVisual <= 0) return 0;
	let consumed = 0;
	let hidden = 0;
	for (const sourceLine of code.split("\n")) {
		const rows = Math.max(1, visualLines(sourceLine, innerWidth).length);
		if (consumed + rows > skippedVisual) break;
		consumed += rows;
		hidden += 1;
	}
	return hidden;
}

const TERMINAL_ESCAPE_SEQUENCE =
	/(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const TERMINAL_CONTROL_RUN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g;

// The window strips escape sequences and control characters (senpi#2839) but never collapses
// whitespace: indentation and inner spacing carry meaning in every language (review HIGH-A),
// and tabs expand to two spaces.
function visualLines(text: string, width: number): string[] {
	return truncateToVisualLines(text, Number.POSITIVE_INFINITY, width).visualLines.map((line) => line.trimEnd());
}

function sanitizeCellCode(code: string): string {
	return code
		.split("\n")
		.map((line) => line.replace(TERMINAL_ESCAPE_SEQUENCE, "").replace(TERMINAL_CONTROL_RUN, "").replace(/\t/g, "  "))
		.join("\n");
}

export function cellOutputSection(
	cell: EvalCellResult,
	environment: RenderEnvironment,
	maxLinesOrBudget: number,
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
		// Fit and pad inside the row budget (review HIGH-C): header + body never exceed the
		// budget, the marker consumes one body row when anything is hidden, and a short section
		// is padded so the block's total height never changes.
		const bodyRows = rowBudget - 1;
		const preview = previewText(styledOutput, bodyRows, innerWidth);
		const body: string[] = [];
		if (preview.skipped > 0) {
			appendLines(
				body,
				renderPrefixed(`${preview.skipped} earlier output lines`, environment, {
					prefix: "│ ",
					continuation: "│ ",
					color: "muted",
				}),
			);
			for (const line of preview.lines.slice(-(bodyRows - 1)))
				appendLines(body, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
		} else {
			for (const line of preview.lines) appendLines(body, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
		}
		const rows = [...lines, ...body];
		while (rows.length < rowBudget) rows.push(style(environment.theme, "borderMuted", "│ "));
		return rows.slice(0, rowBudget);
	}
	const preview = previewText(styledOutput, maxLinesOrBudget, innerWidth);
	if (preview.skipped > 0)
		appendLines(
			lines,
			renderPrefixed(`${preview.skipped} earlier output lines`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "muted",
			}),
		);
	for (const line of preview.lines) appendLines(lines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
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
	// Budget in visual ROWS, not events (review HIGH-C): over-long or multi-line events wrap
	// inside the budget, and the newest event truncates with an ellipsis rather than wrap past it.
	const innerWidth = Math.max(1, environment.width - 2);
	const first = statusEvents[0];
	const omittedByBound = first?.op === "status-events-omitted" && typeof first.count === "number" ? first.count : 0;
	const visible = omittedByBound > 0 ? statusEvents.slice(1) : statusEvents;
	// An over-long or multi-line event truncates with an ellipsis instead of wrapping past the
	// tail budget (review HIGH-C): the shown event rows never exceed the section's body rows.
	const bodyRows = rowBudget - 1;
	// When anything is hidden, the fold marker takes one body row, so the shown events are
	// bodyRows - 1; the marker counts exactly the events not shown plus the stored bound
	// (review HIGH-2, HIGH-C).
	const willOverflow = visible.length > bodyRows;
	const retained = willOverflow ? visible.slice(-Math.max(0, bodyRows - 1)) : visible;
	const skipped = visible.length - retained.length + omittedByBound;
	const shownEventRows = bodyRows - (skipped > 0 ? 1 : 0);
	const rendered = renderStatusEvents(retained, { ...environment, expanded: true });
	const eventRows: string[] = [];
	let clipped = false;
	for (const line of rendered) {
		const wrapped = renderPrefixed(line, environment, FRAME_INNER_PREFIX);
		for (const row of wrapped) {
			if (eventRows.length >= shownEventRows) {
				clipped = true;
				break;
			}
			eventRows.push(row);
		}
		if (clipped) break;
	}
	// An over-long or multi-line event truncates with an ellipsis instead of wrapping past the
	// budget (review HIGH-C): the last shown row carries the cut.
	if (clipped && eventRows.length > 0) {
		const last = eventRows[eventRows.length - 1] ?? "";
		const trimmed = last.replace(/\s*$/u, "");
		eventRows[eventRows.length - 1] = `${trimmed.slice(0, Math.max(0, trimmed.length - 1))}…`;
	}
	const headerRow = renderPrefixed("status", environment, FRAME_SECTION_PREFIX);
	const body: string[] = [];
	if (skipped > 0)
		appendLines(
			body,
			renderPrefixed(`├ … ${skipped} earlier status events`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "dim",
			}),
		);
	appendLines(body, eventRows);
	const keptBody = body.slice(-(rowBudget - 1));
	const rows = [...headerRow, ...keptBody];
	while (rows.length < rowBudget) rows.push(style(environment.theme, "borderMuted", "│ "));
	return rows;
}

export { FRAME_HEADER_PREFIX, FRAME_INNER_PREFIX, FRAME_SECTION_PREFIX };
