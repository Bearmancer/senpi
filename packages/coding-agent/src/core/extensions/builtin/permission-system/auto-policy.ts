import { lstatSync } from "node:fs";
import * as path from "node:path";
import { realpathWithoutOpen } from "../../../../utils/paths.ts";
import { isCredentialPath } from "./auto-credentials.ts";
import { PROGRAM_RULES } from "./auto-program-rules.ts";
import { type ShellWord, splitShellSegments } from "./auto-shell-segments.ts";
import { expandHome, isExternalPath } from "./external-dir.ts";
import type { PermissionRequest } from "./parsers.ts";

export type AutoCommandVerdict = "allow" | "ask";

export interface AutoDecision {
	/** Approve an ask that comes only from a blanket rule (a user's specific ask rule still asks). */
	readonly approveBlanketAsk: boolean;
	readonly requireApproval: boolean;
}

const SAFE_ENV_ASSIGNMENT = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|DEBUG|RUST_BACKTRACE|RUST_LOG|TZ|LANG|LC_ALL)=[^/]*$/;
const SHELL_COMMAND_TOOLS = new Set(["bash", "bash_input"]);
const PATH_PERMISSIONS = new Set(["read", "edit", "list", "grep", "external_directory"]);
const NONE: AutoDecision = { approveBlanketAsk: false, requireApproval: false };

/**
 * Every reading of a word that could name a file: the word itself, the value after `=`, and for a
 * short-option word every tail that could be an attached value (`-o/x`, `-ro/x`, `-Cdir`), since
 * which letter takes a value is program-specific.
 */
function pathCandidates(word: string): string[] {
	const candidates = new Set<string>();
	const separator = word.indexOf("=");
	if (separator > 0) candidates.add(word.slice(separator + 1));
	if (word.startsWith("-")) {
		if (!word.startsWith("--")) {
			for (let index = 2; index < word.length; index += 1) candidates.add(word.slice(index));
		}
	} else {
		candidates.add(word);
	}
	return [...candidates].filter((candidate) => candidate !== "" && candidate !== "-");
}

const resolvesToCredential = (target: string, dir: string): boolean =>
	isCredentialPath(target) || isCredentialPath(realpathWithoutOpen(path.resolve(dir, expandHome(target))));

function touchesOutsideOrCredential(word: ShellWord, dir: string): boolean {
	if (word.hasGlob) return true;
	if (isCredentialPath(word.text)) return true;
	return pathCandidates(word.text).some(
		(candidate) =>
			resolvesToCredential(candidate, dir) || isExternalPath(path.resolve(dir, expandHome(candidate)), dir),
	);
}

const isRegularFile = (target: string): boolean => {
	try {
		return lstatSync(realpathWithoutOpen(target)).isFile();
	} catch {
		return false;
	}
};

/** An outside location the agent may read unasked: never a credential, and grep only one file. */
function isApprovableOutsideRead(toolName: string, target: string, cwd: string): boolean {
	if (resolvesToCredential(target, cwd)) return false;
	const absolute = path.resolve(cwd, expandHome(target));
	if (toolName === "read") return true;
	if (toolName === "grep") return isRegularFile(absolute);
	return toolName === "find" || toolName === "ls";
}

/**
 * Judges a shell command for the `auto` preset. It allows only when every simple command in it
 * is on the fixed policy, stays inside the project, and touches no credential; anything else asks.
 */
export function judgeAutoCommand(command: string, cwd: string): AutoCommandVerdict {
	const segments = splitShellSegments(command);
	if (!segments || segments.length === 0) return "ask";
	let dir = cwd;
	for (const segment of segments) {
		let start = 0;
		while (start < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[start].text)) {
			if (!SAFE_ENV_ASSIGNMENT.test(segment[start].text)) return "ask";
			start += 1;
		}
		const [program, ...args] = segment.slice(start);
		if (!program || program.hasGlob) return "ask";
		if (program.text === "cd") {
			if (args.length !== 1 || touchesOutsideOrCredential(args[0], dir) || args[0].text.startsWith("-"))
				return "ask";
			dir = path.resolve(dir, args[0].text);
			continue;
		}
		const rule = PROGRAM_RULES.get(program.text);
		if (!rule?.(args)) return "ask";
		if (args.some((arg) => touchesOutsideOrCredential(arg, dir))) return "ask";
	}
	return "allow";
}

export function decideAuto(
	toolName: string,
	input: Record<string, unknown>,
	request: PermissionRequest,
	cwd: string,
): AutoDecision {
	if (
		PATH_PERMISSIONS.has(request.permission) &&
		request.patterns.some((pattern) => resolvesToCredential(pattern, cwd))
	) {
		return { approveBlanketAsk: false, requireApproval: true };
	}
	const command =
		typeof input.command === "string" ? input.command : typeof input.input === "string" ? input.input : undefined;
	const isShellCommand =
		SHELL_COMMAND_TOOLS.has(toolName) || (toolName === "monitor" && typeof input.command === "string");
	if (isShellCommand && request.permission === "bash" && command !== undefined) {
		return { approveBlanketAsk: judgeAutoCommand(command, cwd) === "allow", requireApproval: false };
	}
	if (request.permission === "external_directory") {
		return {
			approveBlanketAsk: request.patterns.every((pattern) => isApprovableOutsideRead(toolName, pattern, cwd)),
			requireApproval: false,
		};
	}
	return NONE;
}
