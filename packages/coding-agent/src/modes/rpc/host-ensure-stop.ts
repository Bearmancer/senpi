/**
 * HOW an ensure stops a supervisor it is entitled to stop: SIGTERM, a deadline, then SIGKILL - with
 * the stop intent on record before the first signal and, when the SIGKILL was needed, the terminal
 * record written by THIS process, because a SIGKILLed supervisor runs no exit handler (senpi#2566).
 * Split out of `host-ensure.ts`.
 */
import type { ChildProcess } from "node:child_process";
import {
	type DaemonPidFile,
	ProcessIdentityUnreadableError,
	processIsLive,
	processMatchesPidFile,
	readProcessStartTime,
} from "../app-server/daemon/process.ts";
import { noteEscalatedStop } from "./host-child-exit.ts";
import type { HostStopSender } from "./host-crash-record.ts";
import type { HostGenerationPaths } from "./host-daemon-paths.ts";
import type { ChildExit } from "./host-readiness.ts";
import { type HostStopIntent, readStopIntent, writeStopIntent } from "./host-stop-intent.ts";

export const DEFAULT_STOP_TIMEOUT_MS = 10_000;
export const SIGKILL_GRACE_MS = 2_000;

export interface StopTarget {
	readonly daemonDir: string;
	readonly generation: HostGenerationPaths;
	readonly instanceId: string;
	readonly sender: HostStopSender;
	readonly reason: string;
}

export function ensureSender(): HostStopSender {
	return { pid: process.pid, kind: "ensure" };
}

export async function announceStop(target: StopTarget, targetPid: number): Promise<HostStopIntent> {
	const intent: HostStopIntent = {
		sender: target.sender,
		targetPid,
		reason: target.reason,
		signal: "SIGTERM",
		at: new Date().toISOString(),
	};
	await writeStopIntent(target.generation, intent);
	return intent;
}

/**
 * The supervisor was SIGKILLed and is gone: record the generation's end before the caller releases
 * the registration that holds the intent. The intent as the supervisor last left it wins - it may have
 * layered its own step on - and the one this caller wrote stands in when the file is gone.
 */
export async function recordEscalation(target: StopTarget, announced: HostStopIntent): Promise<void> {
	const current = await readStopIntent(target.generation).catch(() => undefined);
	await noteEscalatedStop(target.daemonDir, target.instanceId, current ?? announced);
}

export async function stopSpawnedChild(
	child: ChildProcess,
	childExit: Promise<ChildExit>,
	termTimeoutMs: number,
	target: StopTarget,
): Promise<void> {
	const exited = () => child.exitCode !== null || child.signalCode !== null;
	const pid = child.pid;
	if (exited() || pid === undefined) return;
	const waitFor = (ms: number) => Promise.race([childExit.then(() => true), delay(ms).then(() => exited())]);
	const announced = await announceStop(target, pid);
	signalPid(pid, "SIGTERM");
	if (await waitFor(termTimeoutMs)) return;
	signalPid(pid, "SIGKILL");
	if (!(await waitFor(SIGKILL_GRACE_MS))) {
		throw new Error(`RPC socket host pid ${pid} remained alive after SIGKILL`);
	}
	await recordEscalation(target, announced);
}

/** Replacing a managed host nothing can reach: only through its validated pidfile (I1). */
export async function stopManagedHost(
	pidFile: DaemonPidFile,
	termTimeoutMs: number,
	target: StopTarget,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<void> {
	const announced = await announceStop(target, pidFile.pid);
	await signalValidated(pidFile, "SIGTERM", readStartTime);
	if (await waitForGone(pidFile, termTimeoutMs, readStartTime)) return;
	await signalValidated(pidFile, "SIGKILL", readStartTime);
	if (!(await waitForGone(pidFile, SIGKILL_GRACE_MS, readStartTime))) {
		throw new Error(`RPC socket host pid ${pidFile.pid} remained alive after SIGKILL`);
	}
	await recordEscalation(target, announced);
}

type PidFileOwnership = "owns" | "gone" | "unknown";

// One probe per call: the teardown loops below are themselves the retry, so the
// budget inside processMatchesPidFile would only multiply their wall time. A probe
// that fails against a LIVE pid is "unknown" — it proves nothing about ownership, so
// signalling on it would be unsafe and treating it as "gone" would abandon a host that
// may still be running. A failed probe against a dead pid is "gone".
export async function resolvePidFileOwnership(
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
	readStartTime: (pid: number) => Promise<string | undefined>,
): Promise<void> {
	if ((await resolvePidFileOwnership(pidFile, readStartTime)) !== "owns") return;
	signalPid(pidFile.pid, signal);
}

async function waitForGone(
	pidFile: DaemonPidFile,
	timeoutMs: number,
	readStartTime: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if ((await resolvePidFileOwnership(pidFile, readStartTime)) === "gone") return true;
		await delay(50);
	}
	return (await resolvePidFileOwnership(pidFile, readStartTime)) === "gone";
}

/** ESRCH means the process is already gone, which is what every caller here wants. */
export function signalPid(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error: unknown) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
