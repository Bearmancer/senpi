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
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const NONE: AutoDecision = { approveBlanketAsk: false, requireApproval: false };

function pathCandidates(word: string): string[] {
	const separator = word.indexOf("=");
	return separator > 0 ? [word, word.slice(separator + 1)] : [word];
}

function touchesOutsideOrCredential(word: ShellWord, dir: string): boolean {
	if (word.hasGlob) return true;
	return pathCandidates(word.text).some((candidate) => {
		if (candidate === "" || candidate === "-") return false;
		if (isCredentialPath(candidate)) return true;
		if (candidate.startsWith("-")) return false;
		const absolute = path.resolve(dir, expandHome(candidate));
		return isExternalPath(absolute, dir) || isCredentialPath(realpathWithoutOpen(absolute));
	});
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
	if (request.patterns.some((pattern) => isCredentialPath(pattern))) {
		return { approveBlanketAsk: false, requireApproval: true };
	}
	const command =
		typeof input.command === "string" ? input.command : typeof input.input === "string" ? input.input : undefined;
	const isShellCommand =
		SHELL_COMMAND_TOOLS.has(toolName) || (toolName === "monitor" && typeof input.command === "string");
	if (isShellCommand && request.permission === "bash" && command !== undefined) {
		return { approveBlanketAsk: judgeAutoCommand(command, cwd) === "allow", requireApproval: false };
	}
	if (READ_TOOLS.has(toolName) && request.permission === "external_directory") {
		return { approveBlanketAsk: true, requireApproval: false };
	}
	return NONE;
}
