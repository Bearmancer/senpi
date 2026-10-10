/**
 * HOW the supervisor ends its generation: the single-flight teardown, the child stop, and the order
 * that keeps the record of the child's end ahead of the release of the directory it cites. Split out
 * of `host-lifecycle.ts`, which keeps the supervisor's orchestration (senpi#2566).
 */
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import type { Server } from "node:net";
import type { HostStopSender } from "./host-crash-record.ts";
import type { HostDaemonPaths, HostGenerationPaths } from "./host-daemon-paths.ts";
import { releaseGeneration } from "./host-daemon-registration.ts";
import type { SupervisorActivity } from "./host-lifecycle-activity.ts";
import type { SupervisorDrain } from "./host-lifecycle-drain.ts";
import { closeServer } from "./host-lifecycle-proxy.ts";
import { waitOutStalledChild } from "./host-lifecycle-stall-wait.ts";
import {
	CHILD_KILL_EXIT_TIMEOUT_MS,
	CHILD_STOP_TIMEOUT_MS,
	layeredSupervisorIntent,
	readStopIntent,
	writeStopIntent,
} from "./host-stop-intent.ts";
import { errorMessage, supervisorLog, writeStderrLine } from "./host-supervisor-log.ts";
import { type SocketFileIdentity, shieldSocketDuringClose, unlinkOwnedSocket } from "./socket-ownership.ts";

export { CHILD_STOP_TIMEOUT_MS } from "./host-stop-intent.ts";

/** Win32 named-pipe shutdown can leave supervisor handles live after close starts. */
const WINDOWS_SUPERVISOR_SHUTDOWN_HARD_EXIT_MS = 2_000;

export interface SupervisorState {
	shuttingDown: boolean;
	shutdownReason: string | undefined;
	/** Settles once the child's end is on record; replaced the moment the child exits. */
	childExitRecorded: Promise<void>;
	publicSocketOwned: boolean;
	publicSocketIdentity: SocketFileIdentity | undefined;
	/** Another generation's entry replaced the public socket this one bound: its registration is the replacer's now. */
	endpointReplaced: boolean;
}

export interface SupervisorShutdown {
	readonly paths: HostDaemonPaths;
	readonly generation: HostGenerationPaths;
	readonly instanceId: string;
	readonly publicSocket: string;
	readonly server: Server;
	readonly internalDir: string | undefined;
	readonly child: ChildProcess;
	readonly activity: SupervisorActivity;
	readonly drain: SupervisorDrain;
	readonly state: SupervisorState;
	/** Stops the idle ticker, the supersession watch and the win32 identity watchdog. */
	readonly stopWatchers: () => void;
}

export function supervisorSender(instanceId: string): HostStopSender {
	return { pid: process.pid, kind: "supervisor", generation: instanceId };
}

export function childExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

export async function performShutdown(context: SupervisorShutdown, reason: string, exitCode: number): Promise<never> {
	const { state, child } = context;
	state.shuttingDown = true;
	state.shutdownReason = reason;
	context.stopWatchers();
	context.drain.stop();
	let hardExit: ReturnType<typeof setTimeout> | undefined;
	try {
		writeStderrLine(`senpi rpc host supervisor: ${reason} shutdown`);
		context.activity.clients.destroyAll();
		// No fallible socket/metadata cleanup may bypass the child's observed exit.
		await stopChild(context, reason);
		await state.childExitRecorded;
		if (process.platform === "win32")
			hardExit = setTimeout(() => process.exit(exitCode), WINDOWS_SUPERVISOR_SHUTDOWN_HARD_EXIT_MS);
		// libuv unlinks the bound NAME when the listening handle closes - which would delete a newer
		// host's entry renamed over this path. Shield the current entry for the close, then let the
		// ownership check decide. A drained supervisor already stopped accepting.
		if (!context.drain.active) await shieldSocketDuringClose(context.publicSocket, () => closeServer(context.server));
		if (context.internalDir) await rm(context.internalDir, { recursive: true, force: true });
		context.activity.stopObserver();
		if (state.publicSocketOwned && process.platform !== "win32") {
			// Ownership-checked: after a takeover a newer host may have published a fresh entry here.
			await unlinkOwnedSocket(context.publicSocket, state.publicSocketIdentity, supervisorLog);
		}
		// After a handoff the pointer describes the SUCCESSOR, so this drops only the generation
		// directory of the process that is leaving, and the pointer only while it still names it. A
		// generation whose socket was taken over leaves the pointer and settings to the replacer (#2536).
		await releaseGeneration(context.paths, {
			instanceId: context.instanceId,
			pid: process.pid,
			superseded: state.endpointReplaced,
		});
	} catch (cause) {
		// In particular, an unobserved child exit leaves its generation, pointer and settings intact.
		supervisorLog(`shutdown failed for host child pid ${child.pid ?? "unknown"}: ${errorMessage(cause)}`);
		exitCode = 1;
	} finally {
		if (hardExit) clearTimeout(hardExit);
		// Windows named-pipe handles can outlive their JavaScript wrappers, so cleanup failure must
		// never leave the supervisor resident or the host orphaned.
		process.exit(exitCode);
	}
}

/**
 * SIGTERM, then SIGKILL after `CHILD_STOP_TIMEOUT_MS` - or, for a child that is alive but stalled, after
 * the bounded stall wait. The intent is on record BEFORE the signal, layered over any outer sender's
 * intent for this generation so the record names who started it, and names a stall-wait escalation.
 */
async function stopChild(context: SupervisorShutdown, reason: string): Promise<void> {
	const { child, generation } = context;
	const pid = child.pid;
	if (childExited(child) || pid === undefined) return;
	const outer = await readStopIntent(generation).catch((cause) => {
		supervisorLog(`cannot read child stop intent: ${errorMessage(cause)}`);
		return undefined;
	});
	const at = new Date().toISOString();
	const intent = layeredSupervisorIntent(outer, supervisorSender(context.instanceId), { targetPid: pid, reason, at });
	await writeStopIntent(generation, intent, supervisorLog);
	const signalledAt = Date.now();
	signalChild(pid, "SIGTERM");
	if (await waitForChildExit(child, CHILD_STOP_TIMEOUT_MS)) return;
	const stallWaitMs = await waitOutStalledChild({
		child,
		generation,
		signalledAt,
		waitForExit: waitForChildExit,
	});
	if (childExited(child)) return;
	if (stallWaitMs > 0) {
		const escalated = { ...intent, reason: `${intent.reason}; escalated_after_stall_wait=${stallWaitMs}` };
		await writeStopIntent(generation, escalated, supervisorLog);
	}
	signalChild(pid, "SIGKILL");
	// SIGKILL cannot be ignored; the bound is only a circuit breaker for an uninterruptible kernel wait.
	if (!(await waitForChildExit(child, CHILD_KILL_EXIT_TIMEOUT_MS)))
		throw new Error(`host child pid ${pid} exit unobserved ${CHILD_KILL_EXIT_TIMEOUT_MS}ms after SIGKILL`);
}

function signalChild(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (childExited(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", onExit);
	});
}

/**
 * External stop (ensureHost replacement, tests, QA) must clean up like idle exit; SIGUSR1 is the
 * gentler request - finish what you are doing and leave - that a generation handoff and
 * `stopHost({ drain: true })` both send. It exists on POSIX only, which is one reason win32 hosts
 * are attach-only: no signal there means anything but "terminate".
 */
export function registerSupervisorSignals(
	shutdown: (reason: string, exitCode: number) => Promise<never>,
	drain: () => void,
): void {
	for (const signal of process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const)) {
		process.on(signal, () => {
			void shutdown(`signal:${signal}`, signal === "SIGHUP" ? 129 : 143);
		});
	}
	if (process.platform !== "win32") process.on("SIGUSR1", drain);
}
