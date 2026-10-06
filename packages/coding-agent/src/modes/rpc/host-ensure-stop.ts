/** Stopping a host this ensure owns: through the spawned child's handle, or through a validated pidfile. */
import type { ChildProcess } from "node:child_process";
import {
	type DaemonPidFile,
	ProcessIdentityUnreadableError,
	processIsLive,
	processMatchesPidFile,
	readProcessStartTime,
} from "../app-server/daemon/process.ts";
import type { ChildExit } from "./host-readiness.ts";

export const SIGKILL_GRACE_MS = 2_000;

/**
 * Ownership for the reuse decision. An identity we cannot read proves nothing: it can neither
 * claim the host nor authorize a kill, so it reads as "not ours" and the caller starts fresh
 * rather than failing the whole ensure on an observation gap.
 */
export async function matchesPidFileOrUnknown(
	pidFile: DaemonPidFile,
	probe: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
	try {
		return await processMatchesPidFile(pidFile, probe);
	} catch (error: unknown) {
		if (error instanceof ProcessIdentityUnreadableError) return false;
		throw error;
	}
}

export async function stopSpawnedChild(
	child: ChildProcess,
	childExit: Promise<ChildExit>,
	termTimeoutMs: number,
): Promise<void> {
	const exited = () => child.exitCode !== null || child.signalCode !== null;
	if (exited()) return;
	const signal = (name: NodeJS.Signals) => {
		try {
			child.kill(name);
		} catch (error: unknown) {
			if (!isNodeErrorCode(error, "ESRCH")) throw error;
		}
	};
	const waitFor = (ms: number) => Promise.race([childExit.then(() => true), delay(ms).then(() => exited())]);
	signal("SIGTERM");
	if (await waitFor(termTimeoutMs)) return;
	signal("SIGKILL");
	if (!(await waitFor(SIGKILL_GRACE_MS))) {
		throw new Error(`RPC socket host pid ${child.pid ?? "?"} remained alive after SIGKILL`);
	}
}

export async function stopManagedHost(
	pidFile: DaemonPidFile,
	termTimeoutMs: number,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<void> {
	await signalValidated(pidFile, "SIGTERM", readStartTime);
	if (await waitForGone(pidFile, termTimeoutMs, readStartTime)) return;
	await signalValidated(pidFile, "SIGKILL", readStartTime);
	if (!(await waitForGone(pidFile, SIGKILL_GRACE_MS, readStartTime))) {
		throw new Error(`RPC socket host pid ${pidFile.pid} remained alive after SIGKILL`);
	}
}

type PidFileOwnership = "owns" | "gone" | "unknown";

// One probe per call: the teardown loops below are themselves the retry, so the
// budget inside processMatchesPidFile would only multiply their wall time. A probe
// that fails against a LIVE pid is "unknown" — it proves nothing about ownership, so
// signalling on it would be unsafe and treating it as "gone" would abandon a host that
// may still be running. A failed probe against a dead pid is "gone".
async function resolvePidFileOwnership(
	pidFile: DaemonPidFile,
	readStartTime: (pid: number) => Promise<string | undefined>,
): Promise<PidFileOwnership> {
	try {
		return (await processMatchesPidFile(pidFile, readStartTime, processIsLive, { attempts: 1 })) ? "owns" : "gone";
	} catch (error: unknown) {
		if (error instanceof ProcessIdentityUnreadableError) return "unknown";
		throw error;
	}
}

async function signalValidated(
	pidFile: DaemonPidFile,
	signal: NodeJS.Signals,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<void> {
	if ((await resolvePidFileOwnership(pidFile, readStartTime)) !== "owns") return;
	try {
		process.kill(pidFile.pid, signal);
	} catch (error: unknown) {
		if (!isNodeErrorCode(error, "ESRCH")) throw error;
	}
}

async function waitForGone(
	pidFile: DaemonPidFile,
	timeoutMs: number,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if ((await resolvePidFileOwnership(pidFile, readStartTime)) === "gone") return true;
		await delay(50);
	}
	return (await resolvePidFileOwnership(pidFile, readStartTime)) === "gone";
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
