import { resolve } from "node:path";
import { RESOLUTION_TIMED_OUT, withResolutionDeadline } from "../../../tools/bounded-realpath.ts";
import type { ExtensionAPI, ToolCallEventResult } from "../../types.ts";
import { extractPatchedPaths } from "../gpt-apply-patch/text.ts";
import { type MovedPath, movedPathReason } from "./breadcrumb-trust.ts";
import { commandPaths } from "./command-paths.ts";
import { logGuardEvent } from "./guard-log.ts";
import { knownMove, looksMoved } from "./known-moves.ts";
import { createMovedPathProbe, type MovedPathProbe, pathExists, STEP_DEADLINE_MS } from "./resolve-async.ts";
import { MOVED_PATH_TOOL_CLASSES } from "./tool-classes.ts";

/**
 * Bounds on one call's check (senpi#2898): at most `MAX_PROBED_PATHS` paths get filesystem resolution, within
 * `CALL_DEADLINE_MS`. Neither fails open: paths past the cap, and every path when the deadline passes, are still
 * refused by text when they lie under a prefix of a breadcrumb trusted earlier in this process.
 */
export const MAX_PROBED_PATHS = 64;
const CALL_DEADLINE_MS = 4 * STEP_DEADLINE_MS;
/** Strings an unclassified tool's arguments contribute; text scanning only, no filesystem work per string. */
const MAX_ARGUMENT_STRINGS = 4096;

interface Target {
	readonly path: string;
	/** A read-only target counts only when it is missing (the hint case). */
	readonly onlyIfMissing: boolean;
}

function allStrings(value: unknown, found: string[] = []): string[] {
	if (found.length >= MAX_ARGUMENT_STRINGS) return found;
	if (typeof value === "string") found.push(value);
	else if (Array.isArray(value)) for (const item of value) allStrings(item, found);
	else if (typeof value === "object" && value !== null)
		for (const item of Object.values(value)) allStrings(item, found);
	return found;
}

function stringsOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function targets(toolName: string, input: Record<string, unknown>, cwd: string): Target[] {
	const toolClass = MOVED_PATH_TOOL_CLASSES[toolName];
	const of = (paths: readonly string[], onlyIfMissing = false): Target[] =>
		paths.map((path) => ({ path: resolve(cwd, path), onlyIfMissing }));
	switch (toolClass?.kind) {
		case "patch":
			return of(extractPatchedPaths(stringsOf(input.input).join("\n")));
		case "command":
			return of([cwd, ...commandPaths(stringsOf(input[toolClass.field]).join("\n"), cwd)]);
		case "paths":
			return [
				...of(toolClass.write.flatMap((field) => stringsOf(input[field]))),
				...of(
					toolClass.read.flatMap((field) => stringsOf(input[field])),
					true,
				),
			];
		case undefined:
			return of(commandPaths(allStrings(input).join("\n"), cwd));
		case "filesystem-policy":
		case "none":
			return [];
	}
}

function firstKnownMove(list: readonly Target[], probe: MovedPathProbe): MovedPath | undefined {
	for (const target of list) {
		if (probe.cleared(target.path)) continue;
		const moved = knownMove(target.path);
		if (moved) return moved;
	}
	return undefined;
}

async function checkTargets(list: readonly Target[]): Promise<MovedPath | undefined> {
	const ordered = [...list.filter((target) => looksMoved(target.path)), ...list.filter((t) => !looksMoved(t.path))];
	const probe = createMovedPathProbe();
	const unprobed: Target[] = [];
	let probes = 0;
	const probing = (async () => {
		for (const target of ordered) {
			// One decision per listed prefix: a prefix found re-used clears every later target under it, at no cost.
			if (probe.cleared(target.path)) continue;
			if (probes >= MAX_PROBED_PATHS) {
				unprobed.push(target);
				continue;
			}
			probes++;
			if (target.onlyIfMissing && (await pathExists(target.path))) continue;
			const moved = await probe.resolve(target.path);
			if (moved) return moved;
		}
		return undefined;
	})();
	const result = await withResolutionDeadline(probing, CALL_DEADLINE_MS);
	if (probe.timedOut) logGuardEvent("debug", "call_bound_reached", { bound: "step", count: String(ordered.length) });
	if (unprobed.length > 0)
		logGuardEvent("debug", "call_bound_reached", { bound: "paths", count: String(ordered.length) });
	if (result !== RESOLUTION_TIMED_OUT) return result ?? firstKnownMove(unprobed, probe);
	logGuardEvent("debug", "call_bound_reached", { bound: "deadline", count: String(ordered.length) });
	return firstKnownMove(ordered, probe);
}

/**
 * Guards paths the OmO desktop moved with its data home (senpi#2898). File tools go through the filesystem
 * policy: a write into a moved prefix is denied, and a read of a moved path that is gone is denied with its
 * new location instead of ENOENT. Every other tool that names paths is stopped by a blocking `tool_call`
 * handler, which also sees calls a codemode script makes through `ctx.executeTool()`.
 */
export default function movedPathGuardExtension(pi: ExtensionAPI): void {
	pi.registerFilesystemPolicy({
		check: async ({ operation, canonicalPath }) => {
			const moved = await checkTargets([{ path: canonicalPath, onlyIfMissing: operation !== "write" }]);
			return moved ? { allow: false, reason: movedPathReason(moved) } : { allow: true };
		},
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		const moved = await checkTargets(targets(event.toolName, event.input, ctx.cwd));
		return moved ? { block: true, reason: movedPathReason(moved) } : undefined;
	});
}
