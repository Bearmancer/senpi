import {
	appendLines,
	type PrefixStyle,
	previewText,
	type RenderEnvironment,
	renderPrefixed,
	style,
} from "./render-blocks.ts";
import { renderStatusEvents } from "./render-status.ts";
import type { EvalCellResult } from "./types.ts";

const FRAME_SECTION_PREFIX: PrefixStyle = { prefix: "├─ ", continuation: "│  ", color: "dim" };
const FRAME_INNER_PREFIX: PrefixStyle = { prefix: "│ ", continuation: "│ ", color: "borderMuted" };

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
