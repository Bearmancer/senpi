import { sanitizeTerminalLabel, visibleWidth } from "@code-yeongyu/senpi";
import { highlightedCode } from "./code-preview.ts";
import { leadsWithHeadline, liveHeadline } from "./live-headline.ts";
import { renderAgentProgressEvents } from "./render-agent.ts";
import {
	appendLines,
	assertNever,
	CODE_PREVIEW_LINES,
	LIVE_RENDER_TICK_MS,
	OUTPUT_PREVIEW_LINES,
	type PrefixStyle,
	previewText,
	type RenderBlock,
	type RenderEnvironment,
	renderAllVisualLines,
	renderPrefixed,
	type StatusPresentation,
	SUMMARY_PREVIEW_LINES,
	spinner,
	style,
} from "./render-blocks.ts";
import { formatThroughputBadge, renderStatusEvents } from "./render-status.ts";
import { formatRuntimeBadge } from "./runtime-label.ts";
import { formatDuration } from "./tool-widgets.ts";
import type { EvalCellResult, EvalToolDetails } from "./types.ts";

type CellStatus = EvalCellResult["status"];
type CellThroughput = { readonly calls: number; readonly wallDurationMs: number | undefined };
export type CellBadges = {
	readonly reset: boolean;
	readonly timeout: number | undefined;
	readonly throughput: CellThroughput | undefined;
};

export const LIVE_LINE_PREFIX: PrefixStyle = { prefix: "╶─ ", continuation: "   ", color: "borderAccent" };

export function isLiveCellStatus(status: CellStatus): boolean {
	return status === "pending" || status === "running";
}

export function hasLiveCell(details: EvalToolDetails | undefined): boolean {
	return (details?.cells ?? []).some((cell) => isLiveCellStatus(cell.status) && cell.startedAt !== undefined);
}

function cellPresentation(status: CellStatus, spinnerFrame: number | undefined): StatusPresentation {
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
function cellElapsedMs(cell: EvalCellResult, environment: RenderEnvironment): number | undefined {
	if (!isLiveCellStatus(cell.status) || cell.startedAt === undefined) return cell.durationMs;
	return Math.max(0, environment.now - cell.startedAt);
}

// A summary has no length limit, so a collapsed block shows its first lines and marks the cut.
function summaryVisualLines(summary: string, width: number, expanded: boolean): string[] {
	const lines = renderAllVisualLines(summary, width);
	if (expanded || lines.length <= SUMMARY_PREVIEW_LINES) return lines;
	const kept = renderAllVisualLines(summary, Math.max(1, width - 1)).slice(0, SUMMARY_PREVIEW_LINES);
	kept[SUMMARY_PREVIEW_LINES - 1] = `${kept[SUMMARY_PREVIEW_LINES - 1] ?? ""}…`;
	return kept;
}

export function summaryBlock(summary: string, theme: RenderEnvironment["theme"], expanded: boolean): RenderBlock {
	return {
		kind: "dynamic",
		render: (width) => summaryVisualLines(summary, width, expanded).map((line) => style(theme, "muted", line)),
	};
}

function cellHeader(cell: EvalCellResult, environment: RenderEnvironment, badges: CellBadges): string {
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

export function renderCell(cell: EvalCellResult, environment: RenderEnvironment, badges: CellBadges): string[] {
	if (leadsWithHeadline(cell.status) && !environment.expanded && cell.output.trim().length === 0) {
		const statusEvents = (cell.statusEvents ?? []).filter((event) => event.op !== "agent");
		if (statusEvents.length === 0) {
			// Nothing to frame yet: the collapsed live row is its headline alone, one line, no empty box.
			const lines = renderPrefixed(cellHeader(cell, environment, badges), environment, LIVE_LINE_PREFIX);
			const agentEvents = (cell.statusEvents ?? []).filter((event) => event.op === "agent");
			if (agentEvents.length > 0) appendLines(lines, renderAgentProgressEvents(agentEvents, environment));
			return lines;
		}
	}
	const lines = renderPrefixed(cellHeader(cell, environment, badges), environment, {
		prefix: "╭─ ",
		continuation: "│  ",
		color: "borderAccent",
	});
	const headlined = leadsWithHeadline(cell.status);
	if (cell.summary !== undefined && !headlined) {
		appendLines(
			lines,
			summaryVisualLines(cell.summary, Math.max(1, environment.width - 2), environment.expanded).map(
				(line) => `${style(environment.theme, "muted", "│ ")}${style(environment.theme, "muted", line)}`,
			),
		);
	}
	const innerWidth = Math.max(1, environment.width - 2);
	const codePreview =
		headlined && !environment.expanded
			? { lines: [], skipped: 0 }
			: previewText(
					highlightedCode(cell.code, cell.language, environment.theme, environment.repaint),
					environment.expanded ? Number.POSITIVE_INFINITY : CODE_PREVIEW_LINES,
					innerWidth,
				);
	if (codePreview.skipped > 0) {
		appendLines(
			lines,
			renderPrefixed(`${codePreview.skipped} earlier code lines`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "muted",
			}),
		);
	}
	for (const line of codePreview.lines) {
		appendLines(lines, renderPrefixed(line, environment, { prefix: "│ ", continuation: "│ ", color: "borderMuted" }));
	}
	const output = cell.output.trimEnd();
	if (output.length > 0) {
		appendLines(lines, renderPrefixed("output", environment, { prefix: "├─ ", continuation: "│  ", color: "dim" }));
		const outputColor = cell.status === "error" ? "error" : "toolOutput";
		const styledOutput = output
			.split("\n")
			.map((line) => style(environment.theme, outputColor, line))
			.join("\n");
		const outputPreview = previewText(
			styledOutput,
			environment.expanded ? Number.POSITIVE_INFINITY : OUTPUT_PREVIEW_LINES,
			innerWidth,
		);
		if (outputPreview.skipped > 0) {
			appendLines(
				lines,
				renderPrefixed(`${outputPreview.skipped} earlier output lines`, environment, {
					prefix: "│ ",
					continuation: "│ ",
					color: "muted",
				}),
			);
		}
		for (const line of outputPreview.lines) {
			appendLines(
				lines,
				renderPrefixed(line, environment, { prefix: "│ ", continuation: "│ ", color: "borderMuted" }),
			);
		}
	}
	const allEvents = cell.statusEvents ?? [];
	const statusEvents = allEvents.filter((event) => event.op !== "agent");
	if (statusEvents.length > 0) {
		appendLines(lines, renderPrefixed("status", environment, { prefix: "├─ ", continuation: "│  ", color: "dim" }));
		for (const line of renderStatusEvents(statusEvents, environment)) {
			appendLines(
				lines,
				renderPrefixed(line, environment, { prefix: "│ ", continuation: "│ ", color: "borderMuted" }),
			);
		}
	}
	lines.push(style(environment.theme, "borderMuted", "╰─"));
	const agentEvents = allEvents.filter((event) => event.op === "agent");
	if (agentEvents.length > 0) appendLines(lines, renderAgentProgressEvents(agentEvents, environment));
	return lines;
}
