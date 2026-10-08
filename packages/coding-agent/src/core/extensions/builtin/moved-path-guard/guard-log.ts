import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../../config.ts";

export type GuardLogEvent = "breadcrumb_ignored" | "marker_newer" | "call_bound_reached";

const reported = new Set<string>();
let pending: Promise<void> = Promise.resolve();

export function guardLogPath(): string {
	return join(getAgentDir(), "logs", "moved-path-guard.log");
}

/**
 * One JSON line per distinct event and subject, written asynchronously and in order (senpi#2898): the guard runs on
 * the session loop, so it never writes synchronously, and a failing write only loses diagnostics.
 */
export function logGuardEvent(level: "debug" | "warn", event: GuardLogEvent, details: Record<string, string>): void {
	const key = `${event}\0${JSON.stringify(details)}`;
	if (reported.has(key)) return;
	reported.add(key);
	const line = `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...details })}\n`;
	const file = guardLogPath();
	pending = pending
		.then(() => mkdir(dirname(file), { recursive: true, mode: 0o700 }))
		.then(() => appendFile(file, line, { mode: 0o600 }))
		.catch(() => undefined);
}

export function flushGuardLog(): Promise<void> {
	return pending;
}
