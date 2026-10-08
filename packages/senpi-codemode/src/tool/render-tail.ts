import { visibleWidth } from "@code-yeongyu/senpi";
import { appendLines, previewText, type RenderEnvironment, renderPrefixed, style } from "./render-blocks.ts";
import { FRAME_INNER_PREFIX, FRAME_SECTION_PREFIX } from "./render-live.ts";
import { renderStatusEvents } from "./render-status.ts";
import type { EvalCellResult } from "./types.ts";

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
		// is padded so the block's total height never changes. The marker counts every hidden
		// row (review NEW-1): the kept tail plus the marker together are the whole output.
		const bodyRows = rowBudget - 1;
		const preview = previewText(styledOutput, bodyRows, innerWidth);
		const body: string[] = [];
		const kept = preview.skipped > 0 ? preview.lines.slice(-(bodyRows - 1)) : preview.lines;
		const omitted = preview.skipped + preview.lines.length - kept.length;
		if (omitted > 0) {
			appendLines(
				body,
				renderPrefixed(`${omitted} earlier output lines`, environment, {
					prefix: "│ ",
					continuation: "│ ",
					color: "muted",
				}),
			);
		}
		for (const line of kept) appendLines(body, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
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
	if (rowBudget === undefined) {
		const lines = renderPrefixed("status", environment, FRAME_SECTION_PREFIX);
		for (const line of renderStatusEvents(statusEvents, environment))
			appendLines(lines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
		return lines;
	}
	// Budget in visual ROWS, not events (review HIGH-C). The tail keeps the NEWEST rows (review
	// NEW-2): whole events fold from the front into the exact marker when their rows overflow,
	// and a single event that alone overflows keeps its newest rows, its oldest visible row
	// ending in an ANSI-safe ellipsis (review NEW-3).
	const first = statusEvents[0];
	const omittedByBound = first?.op === "status-events-omitted" && typeof first.count === "number" ? first.count : 0;
	const visible = omittedByBound > 0 ? statusEvents.slice(1) : statusEvents;
	const bodyRows = rowBudget - 1;
	// Render each event to its own rows so whole events fold cleanly. The fold marker counts
	// exactly the folded events plus the stored bound (review HIGH-2, HIGH-C).
	const perEvent = visible.map((event) => {
		const rendered = renderStatusEvents([event], { ...environment, expanded: true });
		const rows: string[] = [];
		for (const line of rendered) appendLines(rows, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
		return rows;
	});
	// Keep events from the newest until the next-older one would overflow the body; the newest
	// event is always kept, even when it alone overflows (review NEW-2). The fold marker counts
	// exactly the folded events plus the stored bound (review HIGH-2, HIGH-C).
	const keptEvents: string[][] = [];
	let used = 0;
	let firstShown = perEvent.length;
	for (let i = perEvent.length - 1; i >= 0; i--) {
		const rows = perEvent[i] ?? [];
		// The fold marker appears whenever anything older than event i (an earlier event or the
		// stored bound) is hidden, so it reserves one body row of the budget for keeping event i.
		const marker = i > 0 || omittedByBound > 0 ? 1 : 0;
		if (used + rows.length <= bodyRows - marker || keptEvents.length === 0) {
			keptEvents.unshift(rows);
			used += rows.length;
			firstShown = i;
		} else {
			break;
		}
	}
	const skipped = firstShown + omittedByBound;
	const eventRows: string[] = [];
	for (const rows of keptEvents) appendLines(eventRows, rows);
	// A still-overflowing tail is a single event taller than its share: keep its newest rows
	// and mark the oldest visible row with an ellipsis (review NEW-2, NEW-3).
	const shownBudget = bodyRows - (skipped > 0 ? 1 : 0);
	const overflow = eventRows.length - shownBudget;
	const keptRows = overflow > 0 ? eventRows.slice(overflow) : eventRows;
	if (overflow > 0 && keptRows.length > 0) {
		keptRows[0] = ellipsisRow(keptRows[0] ?? "", environment);
	}
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
	appendLines(body, keptRows);
	const keptBody = body.slice(-(rowBudget - 1));
	const rows = [...renderPrefixed("status", environment, FRAME_SECTION_PREFIX), ...keptBody];
	while (rows.length < rowBudget) rows.push(style(environment.theme, "borderMuted", "│ "));
	return rows;
}

const SGR_PATTERN = /\u001b\[[0-9;]*m/g;

// Append the clip ellipsis to the row's oldest visible row, ANSI-safely (review NEW-3): the
// plain text is cut by display cells to leave one cell for the ellipsis, then re-styled, so
// the row stays inside the width and no escape sequence is split.
function ellipsisRow(row: string, environment: RenderEnvironment): string {
	const prefix = FRAME_INNER_PREFIX.prefix;
	const styledBody = row.startsWith(prefix) ? row.slice(prefix.length) : row;
	const plain = styledBody.replace(SGR_PATTERN, "").replace(/\s+$/u, "");
	// The content budget is the row width minus the prefix and the one cell the ellipsis needs.
	const contentBudget = Math.max(1, environment.width - visibleWidth(prefix) - 1);
	const cut = visibleWidth(plain) > contentBudget ? cellPrefixByWidth(plain, contentBudget) : plain;
	return `${style(environment.theme, FRAME_INNER_PREFIX.color, prefix)}${restyle(styledBody, cut, environment)}…`;
}

function cellPrefixByWidth(text: string, cells: number): string {
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

// Rebuild the styling the cut row carried: walk the styled row's SGR color runs, wrap the
// matching slice of the cut text in the same run, and close each with one reset. A color whose
// text was fully cut away disappears with it, and no escape sequence is ever split.
function restyle(styledBody: string, cut: string, environment: RenderEnvironment): string {
	const theme = environment.theme;
	if (theme === undefined) return cut;
	const runs: { readonly ansi: string; readonly text: string }[] = [];
	let activeAnsi: string | undefined;
	let cursor = 0;
	for (const match of styledBody.matchAll(SGR_PATTERN)) {
		const index = match.index;
		if (activeAnsi !== undefined && index > cursor)
			runs.push({ ansi: activeAnsi, text: styledBody.slice(cursor, index) });
		const sequence = match[0];
		activeAnsi = sequence === "\u001b[39m" || sequence === "\u001b[22;39m" ? undefined : sequence;
		cursor = index + sequence.length;
	}
	if (activeAnsi !== undefined && styledBody.length > cursor)
		runs.push({ ansi: activeAnsi, text: styledBody.slice(cursor) });
	if (runs.length === 0) return cut;
	const out: string[] = [];
	let used = 0;
	for (const run of runs) {
		if (used >= cut.length) break;
		const slice = cut.slice(used, used + run.text.length);
		if (slice.length > 0) out.push(`${run.ansi}${slice}\u001b[39m`);
		used += run.text.length;
	}
	if (used < cut.length) out.push(cut.slice(used));
	return out.join("");
}
