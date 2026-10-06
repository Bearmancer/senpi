import * as fs from "node:fs";
import * as path from "node:path";
import { format } from "node:util";
import { getDebugLogPath } from "../../config.ts";
import { restoreStderr, takeOverStderr } from "../../core/output-guard.ts";
import { redactSensitiveOutput } from "../../core/sensitive-output.ts";
import {
	loadStderrFdSyscalls,
	redirectStderrFd,
	type StderrFdRedirect,
	type StderrFdSyscalls,
} from "./stderr-fd-redirect.ts";

const consoleLevels = ["error", "info", "warn"] as const;

type ConsoleLevel = (typeof consoleLevels)[number];
type ConsoleMethod = (...data: unknown[]) => void;

interface InteractiveConsoleState {
	readonly error: ConsoleMethod;
	readonly info: ConsoleMethod;
	readonly warn: ConsoleMethod;
}

let interactiveConsoleState: InteractiveConsoleState | undefined;
let stderrFdSyscalls: StderrFdSyscalls | undefined;
let stderrFdRedirect: StderrFdRedirect | undefined;

function appendHiddenInteractiveStderr(text: string): void {
	if (text.length === 0) {
		return;
	}
	const debugLogPath = getDebugLogPath();
	const prefix = `[${new Date().toISOString()}] hidden stderr while TUI active\n`;
	const redactedText = redactSensitiveOutput(text);
	const suffix = redactedText.endsWith("\n") ? "" : "\n";
	fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
	fs.appendFileSync(debugLogPath, `${prefix}${redactedText}${suffix}`, { mode: 0o600 });
	fs.chmodSync(debugLogPath, 0o600);
}

function replaceConsoleMethod(level: ConsoleLevel, method: ConsoleMethod): void {
	Object.defineProperty(console, level, {
		configurable: true,
		value: method,
		writable: true,
	});
}

function takeOverInteractiveConsole(): void {
	if (interactiveConsoleState) {
		return;
	}
	interactiveConsoleState = {
		error: console.error,
		info: console.info,
		warn: console.warn,
	};
	const writeHiddenConsoleDiagnostic = (...data: unknown[]) => {
		process.stderr.write(`${format(...data)}\n`);
	};
	for (const level of consoleLevels) {
		replaceConsoleMethod(level, writeHiddenConsoleDiagnostic);
	}
}

function restoreInteractiveConsole(): void {
	if (!interactiveConsoleState) {
		return;
	}
	for (const level of consoleLevels) {
		replaceConsoleMethod(level, interactiveConsoleState[level]);
	}
	interactiveConsoleState = undefined;
}

/** Load the fd-level capture once, before the first takeover; a no-op where it is unsupported. */
export async function prepareInteractiveStderrCapture(): Promise<void> {
	stderrFdSyscalls ??= await loadStderrFdSyscalls().catch(() => undefined);
}

function takeOverStderrFd(): void {
	if (!stderrFdSyscalls || stderrFdRedirect) return;
	try {
		appendHiddenInteractiveStderr("native stderr (fd 2) captured below until the TUI releases the terminal");
		stderrFdRedirect = redirectStderrFd(stderrFdSyscalls, getDebugLogPath());
	} catch {
		stderrFdRedirect = undefined;
	}
}

function restoreStderrFd(): void {
	stderrFdRedirect?.restore();
	stderrFdRedirect = undefined;
}

export function takeOverInteractiveStderr(): void {
	takeOverStderr(appendHiddenInteractiveStderr, redactSensitiveOutput);
	takeOverInteractiveConsole();
	takeOverStderrFd();
}

export function restoreInteractiveStderr(): void {
	restoreStderrFd();
	restoreInteractiveConsole();
	restoreStderr();
}
