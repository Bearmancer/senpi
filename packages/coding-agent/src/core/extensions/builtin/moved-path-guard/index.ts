import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ToolCallEventResult } from "../../types.ts";
import { extractPatchedPaths } from "../gpt-apply-patch/text.ts";
import { commandPaths } from "./command-paths.ts";
import { findMovedPath, type MovedPath, movedPathReason } from "./resolve.ts";
import { MOVED_PATH_TOOL_CLASSES } from "./tool-classes.ts";

function stringsOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function firstMoved(paths: readonly string[], cwd: string, onlyMissing = false): MovedPath | undefined {
	for (const path of paths) {
		const absolute = resolve(cwd, path);
		if (onlyMissing && existsSync(absolute)) continue;
		const moved = findMovedPath(absolute);
		if (moved) return moved;
	}
	return undefined;
}

function movedTarget(toolName: string, input: Record<string, unknown>, cwd: string): MovedPath | undefined {
	const toolClass = MOVED_PATH_TOOL_CLASSES[toolName];
	switch (toolClass?.kind) {
		case "patch":
			return firstMoved(extractPatchedPaths(stringsOf(input.input).join("\n")), cwd);
		case "command":
			return firstMoved([cwd, ...commandPaths(stringsOf(input[toolClass.field]).join("\n"), cwd)], cwd);
		case "paths":
			return (
				firstMoved(
					toolClass.write.flatMap((field) => stringsOf(input[field])),
					cwd,
				) ??
				firstMoved(
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
		check: ({ operation, canonicalPath }) => {
			if (operation !== "write" && existsSync(canonicalPath)) return { allow: true };
			const moved = findMovedPath(canonicalPath);
			return moved ? { allow: false, reason: movedPathReason(moved) } : { allow: true };
		},
	});

	pi.on("tool_call", (event, ctx): ToolCallEventResult | undefined => {
		const moved = movedTarget(event.toolName, event.input, ctx.cwd);
		return moved ? { block: true, reason: movedPathReason(moved) } : undefined;
	});
}
