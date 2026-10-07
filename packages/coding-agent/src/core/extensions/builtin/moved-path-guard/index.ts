import { resolve } from "node:path";
import { RESOLUTION_TIMED_OUT, withResolutionDeadline } from "../../../tools/bounded-realpath.ts";
import type { ExtensionAPI, ToolCallEventResult } from "../../types.ts";
import { extractPatchedPaths } from "../gpt-apply-patch/text.ts";
import { type MovedPath, movedPathReason } from "./breadcrumb-trust.ts";
import { commandPaths, MAX_PATHS_PER_CALL } from "./command-paths.ts";
import { createMovedPathProbe, type MovedPathProbe, pathExists } from "./resolve-async.ts";
import { MOVED_PATH_TOOL_CLASSES } from "./tool-classes.ts";

/** Wall-clock bound on one call's whole check; past it the call proceeds unguarded rather than stall the session. */
const CALL_DEADLINE_MS = 2000;

function stringsOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function firstMoved(
	probe: MovedPathProbe,
	paths: readonly string[],
	cwd: string,
	onlyMissing = false,
): Promise<MovedPath | undefined> {
	for (const path of paths.slice(0, MAX_PATHS_PER_CALL)) {
		const absolute = resolve(cwd, path);
		if (onlyMissing && (await pathExists(absolute))) continue;
		const moved = await probe(absolute);
		if (moved) return moved;
	}
	return undefined;
}

async function movedTarget(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): Promise<MovedPath | undefined> {
	const probe = createMovedPathProbe();
	const toolClass = MOVED_PATH_TOOL_CLASSES[toolName];
	switch (toolClass?.kind) {
		case "patch":
			return firstMoved(probe, extractPatchedPaths(stringsOf(input.input).join("\n")), cwd);
		case "command":
			return firstMoved(probe, [cwd, ...commandPaths(stringsOf(input[toolClass.field]).join("\n"), cwd)], cwd);
		case "paths":
			return (
				(await firstMoved(
					probe,
					toolClass.write.flatMap((field) => stringsOf(input[field])),
					cwd,
				)) ??
				firstMoved(
					probe,
					toolClass.read.flatMap((field) => stringsOf(input[field])),
					cwd,
					true,
				)
			);
		case "filesystem-policy":
		case "none":
		case undefined:
			return undefined;
	}
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
			if (operation !== "write" && (await pathExists(canonicalPath))) return { allow: true };
			const moved = await withResolutionDeadline(createMovedPathProbe()(canonicalPath), CALL_DEADLINE_MS);
			return moved && moved !== RESOLUTION_TIMED_OUT
				? { allow: false, reason: movedPathReason(moved) }
				: { allow: true };
		},
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		const moved = await withResolutionDeadline(movedTarget(event.toolName, event.input, ctx.cwd), CALL_DEADLINE_MS);
		return moved && moved !== RESOLUTION_TIMED_OUT ? { block: true, reason: movedPathReason(moved) } : undefined;
	});
}
