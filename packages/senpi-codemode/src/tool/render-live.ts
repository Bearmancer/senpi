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
};

export const LIVE_LINE_PREFIX: PrefixStyle = { prefix: "╶─ ", continuation: "   ", color: "borderAccent" };
const FRAME_HEADER_PREFIX: PrefixStyle = { prefix: "╭─ ", continuation: "│  ", color: "borderAccent" };
const FRAME_INNER_PREFIX: PrefixStyle = { prefix: "│ ", continuation: "│ ", color: "borderMuted" };
const FRAME_SECTION_PREFIX: PrefixStyle = { prefix: "├─ ", continuation: "│  ", color: "dim" };

export const LIVE_CODE_WINDOW_LINES = 6;
const LIVE_OUTPUT_PREVIEW_LINES = 4;
const LIVE_STATUS_PREVIEW_COUNT = 2;

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

// An in-progress row leads with what the cell is doing (senpi#2802); collapsed, the headline is cut so the whole
// header stays on one line, and the code moves behind expand.
export function headlined(
	icon: string,
	summary: string | undefined,
	code: string | undefined,
	rest: string,
	environment: RenderEnvironment,
): string {
	const budget = environment.expanded ? undefined : environment.width - 3 - visibleWidth(`${icon}  · ${rest}`);
	return `${icon} ${liveHeadline(summary, code, budget)} · ${rest}`;
}

export function cellHeader(cell: EvalCellResult, environment: RenderEnvironment, badges: CellBadges): string {
	const presentation = cellPresentation(
		cell.status,
		environment.spinnerFrame ?? Math.floor((cellElapsedMs(cell, environment) ?? 0) / LIVE_RENDER_TICK_MS),
	);
	const runtimeBadge = cell.runtime === undefined ? "" : ` (${formatRuntimeBadge(cell.language, cell.runtime)})`;
	let header = leadsWithHeadline(cell.status)
		? `eval ${cell.language}${runtimeBadge} ${presentation.label}`
		: `eval ${cell.language}${runtimeBadge} ${presentation.label} ${presentation.icon}`;
	if (cell.queuedBehind !== undefined && cell.queuedBehind.length > 0)
		header += ` · queued behind ${cell.queuedBehind.map(sanitizeTerminalLabel).join(", ")}`;
	else if (cell.queuedBehind !== undefined && cell.status === "queued")
		header += ` · waiting for the ${cell.language} kernel to be ready`;
	const throughputBadge = badges.throughput === undefined ? undefined : formatThroughputBadge(badges.throughput);
	if (throughputBadge !== undefined) header += ` · ${throughputBadge}`;
	const elapsedMs = badges.throughput?.wallDurationMs ?? cellElapsedMs(cell, environment);
	if (elapsedMs !== undefined) header += ` · ${formatDuration(elapsedMs)}`;
	if (badges.reset) header += " · reset";
	if (badges.timeout !== undefined) header += ` · timeout ${badges.timeout}s`;
	if (leadsWithHeadline(cell.status))
		header = headlined(presentation.icon, cell.summary, cell.code, header, environment);
	return style(environment.theme, presentation.color, header);
}

// A live row is a framed block of constant height: the header plus a fixed code window of
// LIVE_CODE_WINDOW_LINES visual lines and a closing border. New lines scroll the window upward;
// the hidden prefix folds into one "N earlier code lines" row counted inside the window, so the
// block never grows the transcript. Streamed output and status events keep their bounded sections.
export function renderLiveCellFrame(
	cell: EvalCellResult,
	environment: RenderEnvironment,
	badges: CellBadges,
): string[] {
	const lines = renderPrefixed(cellHeader(cell, environment, badges), environment, FRAME_HEADER_PREFIX);
	appendLines(lines, liveCodeWindow(cell, environment));
	appendLines(lines, cellOutputSection(cell, environment, LIVE_OUTPUT_PREVIEW_LINES));
	appendLines(lines, cellStatusSection(cell, environment, LIVE_STATUS_PREVIEW_COUNT));
	lines.push(style(environment.theme, "borderMuted", "╰─"));
	return lines;
}

function liveCodeWindow(cell: EvalCellResult, environment: RenderEnvironment): string[] {
	const innerWidth = Math.max(1, environment.width - 2);
	// Streamed code is not yet trusted input: a hostile or half-arrived chunk can carry escape and
	// control characters, and the collapsed row must stay inert in the terminal (senpi#2839).
	const code = highlightedCode(sanitizeCellCode(cell.code), cell.language, environment.theme, environment.repaint);
	const total = truncateToVisualLines(code, Number.POSITIVE_INFINITY, innerWidth).visualLines.length;
	const skipped = Math.max(0, total - LIVE_CODE_WINDOW_LINES);
	const budget = skipped > 0 ? LIVE_CODE_WINDOW_LINES - 1 : LIVE_CODE_WINDOW_LINES;
	const preview = previewText(code, budget, innerWidth);
	const windowLines: string[] = [];
	if (preview.skipped > 0)
		appendLines(
			windowLines,
			renderPrefixed(`${preview.skipped} earlier code lines`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "muted",
			}),
		);
	for (const line of preview.lines) appendLines(windowLines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
	while (windowLines.length < LIVE_CODE_WINDOW_LINES) windowLines.push(style(environment.theme, "borderMuted", "│ "));
	return windowLines.slice(0, LIVE_CODE_WINDOW_LINES);
}

function sanitizeCellCode(code: string): string {
	return code
		.replace(/\u001b\[[0-9;]*m/gu, "")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/gu, " ")
		.replace(/\t/g, "  ");
}

export function cellOutputSection(cell: EvalCellResult, environment: RenderEnvironment, maxLines: number): string[] {
	const output = cell.output.trimEnd();
	if (output.length === 0) return [];
	const lines = renderPrefixed("output", environment, FRAME_SECTION_PREFIX);
	const outputColor = cell.status === "error" ? "error" : "toolOutput";
	const styledOutput = output
		.split("\n")
		.map((line) => style(environment.theme, outputColor, line))
		.join("\n");
	const innerWidth = Math.max(1, environment.width - 2);
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

export function cellStatusSection(
	cell: EvalCellResult,
	environment: RenderEnvironment,
	previewCount: number | undefined,
): string[] {
	const statusEvents = (cell.statusEvents ?? []).filter((event) => event.op !== "agent");
	if (statusEvents.length === 0) return [];
	const lines = renderPrefixed("status", environment, FRAME_SECTION_PREFIX);
	if (previewCount === undefined) {
		for (const line of renderStatusEvents(statusEvents, environment))
			appendLines(lines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
		return lines;
	}
	const retained = statusEvents.slice(-previewCount);
	const skipped = statusEvents.length - retained.length;
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
