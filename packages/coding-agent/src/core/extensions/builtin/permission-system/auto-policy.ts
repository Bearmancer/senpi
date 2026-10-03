import { lstatSync } from "node:fs";
import * as path from "node:path";
import { extractPatchedPaths } from "../gpt-apply-patch/index.ts";
import { isApprovableProjectPath, isApprovableToolPath, resolvePhysicalPath, toolPathSpellings } from "./auto-paths.ts";
import { PROGRAM_RULES } from "./auto-program-rules.ts";
import type { ClassifiedWord } from "./auto-shell-grammar.ts";
import { splitShellSegments } from "./auto-shell-segments.ts";
import { expandHome } from "./external-dir.ts";
import type { PermissionRequest } from "./parsers.ts";

export type AutoCommandVerdict = "allow" | "ask";

export interface AutoDecision {
	/** Approve an ask that comes only from the preset's own rule (a user's rules still win). */
	readonly approveBlanketAsk: boolean;
}

const SHELL_COMMAND_TOOLS = new Set(["bash", "bash_input"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit"]);
const LIST_TOOLS = new Set(["ls", "find"]);
const NO: AutoDecision = { approveBlanketAsk: false };
const YES: AutoDecision = { approveBlanketAsk: true };

const physicalKind = (target: string): "file" | "directory" | "missing" | "other" => {
	const physical = resolvePhysicalPath(target);
	if (physical === undefined) return "other";
	try {
		const stats = lstatSync(physical);
		return stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "other";
	}
};

/**
 * A word a shell program will use as a path, resolved the way the program will: absolute
 * against the command's working directory, with no lexical normalization, so `link/..` follows
 * `link` first. A shell has no `@` or quote fallback, so only `~` is expanded.
 */
function shellPathAllowed(entry: ClassifiedWord, dir: string, cwd: string): boolean {
	if (entry.role === "text") return true;
	const text = entry.word.text;
	if (text === "" || text === "-") return false;
	const expanded = expandHome(text);
	if (expanded.startsWith("~")) return false;
	const target = path.isAbsolute(expanded) ? expanded : `${dir}${path.sep}${expanded}`;
	if (!isApprovableProjectPath(target, cwd) || !isApprovableProjectPath(path.resolve(dir, expanded), cwd)) {
		return false;
	}
	const kind = physicalKind(target);
	if (entry.role === "read-file" || entry.role === "remove-file") return kind === "file";
	if (entry.role === "list") return kind === "file" || kind === "directory";
	return kind !== "other";
}

/**
 * Judges a shell command for the `auto` preset. Every simple command must be a listed program
 * whose every word the program grammar classifies, and every path-valued word must resolve to an
 * approvable project path; anything else asks.
 */
export function judgeAutoCommand(command: string, cwd: string): AutoCommandVerdict {
	const segments = splitShellSegments(command);
	if (!segments || segments.length === 0) return "ask";
	let dir = cwd;
	for (const segment of segments) {
		const [program, ...args] = segment;
		if (!program || program.hasGlob || program.text.includes("=")) return "ask";
		if (program.text === "cd") {
			const target = args[0];
			if (args.length !== 1 || target === undefined || target.hasGlob) return "ask";
			const entry: ClassifiedWord = { role: "list", word: target };
			if (!shellPathAllowed(entry, dir, cwd) || physicalKind(path.resolve(dir, target.text)) !== "directory") {
				return "ask";
			}
			const next = resolvePhysicalPath(
				path.isAbsolute(target.text) ? target.text : `${dir}${path.sep}${target.text}`,
			);
			if (next === undefined) return "ask";
			dir = next;
			continue;
		}
		const classified = PROGRAM_RULES.get(program.text)?.(args);
		if (classified === undefined) return "ask";
		if (!classified.every((entry) => shellPathAllowed(entry, dir, cwd))) return "ask";
	}
	return "allow";
}

const stringPaths = (value: unknown): string[] | undefined => {
	if (value === undefined) return ["."];
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
	return undefined;
};

/** Every location a file tool will touch, as the tool resolves it, must be an approvable project path. */
function toolPathsAllowed(raws: readonly string[], cwd: string, kind: "file" | "list" | "write"): boolean {
	return raws.every((raw) => {
		if (!isApprovableToolPath(raw, cwd)) return false;
		return toolPathSpellings(raw).every((spelling) => {
			const target = path.isAbsolute(spelling) ? spelling : `${cwd}${path.sep}${spelling}`;
			const found = physicalKind(target);
			if (kind === "file") return found === "file" || found === "missing";
			if (kind === "list") return found === "directory" || found === "missing";
			return found === "file" || found === "missing";
		});
	});
}

/**
 * The `auto` preset's allowlist (design note on senpi#2614): it approves only reads, listings,
 * single-file content searches and writes whose every path resolves to an approvable project
 * path, and shell commands the program grammar fully understands. Every other call keeps the
 * preset's ask.
 */
export function decideAuto(
	toolName: string,
	input: Record<string, unknown>,
	request: PermissionRequest,
	cwd: string,
): AutoDecision {
	const isShellCommand =
		SHELL_COMMAND_TOOLS.has(toolName) || (toolName === "monitor" && typeof input.command === "string");
	if (isShellCommand) {
		if (request.permission !== "bash") return NO;
		const command =
			typeof input.command === "string" ? input.command : typeof input.input === "string" ? input.input : undefined;
		return command !== undefined && judgeAutoCommand(command, cwd) === "allow" ? YES : NO;
	}
	if (toolName === "read") {
		const raw = input.path ?? input.file_path;
		return typeof raw === "string" && toolPathsAllowed([raw], cwd, "file") ? YES : NO;
	}
	if (toolName === "grep") {
		const raws = stringPaths(input.path);
		if (raws === undefined) return NO;
		const allFiles = raws.every((raw) =>
			toolPathSpellings(raw).every(
				(spelling) =>
					physicalKind(path.isAbsolute(spelling) ? spelling : `${cwd}${path.sep}${spelling}`) === "file",
			),
		);
		return allFiles && toolPathsAllowed(raws, cwd, "file") ? YES : NO;
	}
	if (LIST_TOOLS.has(toolName)) {
		const raws = stringPaths(input.path);
		return raws !== undefined && toolPathsAllowed(raws, cwd, "list") ? YES : NO;
	}
	if (WRITE_TOOLS.has(toolName)) {
		const raw = input.path ?? input.file_path;
		return typeof raw === "string" && toolPathsAllowed([raw], cwd, "write") ? YES : NO;
	}
	if (toolName === "apply_patch") {
		const patchText = typeof input.input === "string" ? input.input : input.patchText;
		const patched = typeof patchText === "string" ? extractPatchedPaths(patchText) : [];
		return patched.length > 0 && toolPathsAllowed(patched, cwd, "write") ? YES : NO;
	}
	return NO;
}
