#!/usr/bin/env node
/**
 * Lifecycle supervisor for the shared RPC socket host started by ensureHost().
 *
 * Process tree:
 *
 *     ensureHost() ──detached──▶ host-lifecycle.ts (this supervisor, owns the pidfile)
 *                                    │  byte-proxies the public socket
 *                                    ▼
 *                          cli-main --mode rpc --listen unix://<public>.internal
 *
 * The supervisor exists to enforce the host lifecycle policy without touching the
 * RPC host itself:
 *
 * - cold start: `transient` (default) means the host lives for the current login
 *   session and idle-exits; `persistent` never idle-exits.
 * - idle exit: after a continuous window with zero attached client connections
 *   and zero active agent turns, the supervisor tears the host down cleanly
 *   (child SIGTERM first so the host flushes pending output and removes its own
 *   socket, then pidfile/settings removal mirroring ensureHost's cleanupState).
 *
 * Observability without host changes: proxying the public socket yields the
 * exact connection count, and the supervisor keeps one always-on observer
 * connection to the internal socket. The multi-session host broadcasts every
 * session lifecycle/agent event to every connection, so the observer sees
 * `agent_start`/`agent_settled` for all sessions even when no client is
 * attached. If the observer connection is ever unhealthy, activity is reported
 * as unknown (non-idle), so a broken observer can only keep the host alive,
 * never kill it mid-turn - for one idle window. Past that, unknown has held
 * the host open for as long as idleness itself would have, and it stops
 * counting as busy; the link keeps reconnecting the whole time (#1979).
 *
 * Lifetime binding: the host is spawned with an extra inherited pipe on fd 3
 * whose write end this supervisor holds and never writes to. The kernel closes
 * that end whenever the supervisor dies - including SIGKILL, an OOM kill, or a
 * crash, where no JS handler runs at all - so the host reads EOF and shuts down
 * cleanly, removing the private internal directory. `stopChild()` remains the
 * fast path for orderly shutdowns; the pipe is what makes an orphaned host
 * impossible. `SENPI_RPC_HOST_WATCH_PPID` is passed alongside as a belt-and-
 * braces fallback for platforms where the extra fd is not inherited.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, isBundledNode } from "../../config.ts";
import { classifyChildExit, noteChildExit } from "./host-child-exit.ts";
import { hostCrashCleanupPaths } from "./host-cleanup-paths.ts";
import { createHostDaemonPaths, generationPaths, HOST_DAEMON_DIR_ENV } from "./host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";
import { SupervisorActivity } from "./host-lifecycle-activity.ts";
import { drainOnPublicSocketLoss, SupervisorDrain, watchWin32ChildIdentity } from "./host-lifecycle-drain.ts";
import {
	createInternalSocketPath,
	parseSupervisorArgs,
	readSettingsFile,
	recordChildPid,
	resolveHostChildLaunch,
	type SupervisorLaunch,
	spawnableChildLaunch,
} from "./host-lifecycle-launch.ts";
import { resolveHostPolicy } from "./host-lifecycle-policy.ts";
import {
	adoptPublicSocket,
	createPublicProxy,
	ensurePublicSocketSecret,
	listen,
	prepareSocketPath,
	waitForListener,
} from "./host-lifecycle-proxy.ts";
import {
	performShutdown,
	registerSupervisorSignals,
	type SupervisorShutdown,
	type SupervisorState,
	supervisorSender,
} from "./host-lifecycle-shutdown.ts";
import { errorMessage, writeStderrLine } from "./host-supervisor-log.ts";
import {
	HOST_CLEANUP_PATHS_ENV,
	HOST_PUBLIC_SOCKET_ENV,
	HOST_SCRATCH_DIR_ENV,
	HOST_WATCH_FD_ENV,
	HOST_WATCH_PPID_ENV,
} from "./host-watchdog.ts";
import { PUBLIC_SOCKET_IDENTITY_FILE, statSocketIdentity, writeSocketIdentityFile } from "./socket-ownership.ts";
import { createSocketSecret, SOCKET_SECRET_FILE_ENV, socketSecretPath } from "./socket-transport.ts";

// The exit verdict, the launch surface and the cold-start/idle-exit policy live in their own modules
// (host-child-exit.ts, host-lifecycle-launch.ts, host-lifecycle-policy.ts); they stay exported from
// here so every existing importer keeps resolving them at their original home.
export { classifyChildExit } from "./host-child-exit.ts";
export {
	createInternalSocketPath,
	findInternalSupervisorArgs,
	INTERNAL_SUPERVISOR_FLAG,
	parseSupervisorArgs,
	resolveCliMainPath,
	resolveHostChildLaunch,
	type SupervisorLaunch,
	spawnableChildLaunch,
} from "./host-lifecycle-launch.ts";
export {
	DEFAULT_HANDOFF_GRACE_MS,
	DEFAULT_HOST_IDLE_EXIT_MS,
	HANDOFF_GRACE_MS_ENV,
	HOST_COLD_START_ENV,
	HOST_IDLE_EXIT_MS_ENV,
	type HostActivity,
	type HostColdStart,
	type HostLifecyclePolicy,
	type HostLifecyclePolicyInput,
	IdleExitDecider,
	type IdleExitDecision,
	parseColdStart,
	parseIdleExitMs,
	resolveHostPolicy,
} from "./host-lifecycle-policy.ts";

/**
 * Child stdio slot carrying the supervisor-lifetime pipe. The supervisor holds
 * the write end open and never writes; the kernel closes it when the supervisor
 * dies for ANY reason (SIGKILL, OOM kill, crash), so the host sees EOF on this
 * fd and shuts itself down. Catchable-signal cleanup alone cannot do this.
 */
const CHILD_WATCH_FD = 3;

export async function runHostSupervisor(launch: SupervisorLaunch): Promise<void> {
	const paths = createHostDaemonPaths({ socket: launch.socket, agentDir: launch.agentDir ?? getAgentDir() });
	// Which generation this supervisor is: the ensure that spawned it says so, and a DIRECT launch
	// (the hidden supervisor route, with no ensure behind it) names itself so its child agrees.
	const told = process.env[HOST_INSTANCE_ID_ENV];
	const instanceId = told !== undefined && told.trim() !== "" ? told : randomUUID();
	const generation = generationPaths(paths, instanceId);
	const policy = resolveHostPolicy(await readSettingsFile(paths.settingsFile), process.env);
	const publicSocket = launch.socket;
	// A successor generation binds its own name and adopts the public one by rename; an ordinary
	// start binds the public name directly. Everything downstream - the child's environment, the
	// ownership token, the teardown - is expressed in terms of the PUBLIC path either way.
	const bindSocket = launch.bindSocket ?? publicSocket;
	const successor = launch.bindSocket !== undefined;
	// Direct-launch contract: the supervisor owns the public secret. ensureHost()
	// writes it before spawning, but the hidden --internal-rpc-host-supervisor route
	// has no such caller, so a fresh profile would otherwise die reading it (#1370).
	// It is provisioned BEFORE the internal hop and the child so a provisioning
	// failure leaves no scratch directory and no host process behind.
	const publicSecret = process.platform === "win32" ? await ensurePublicSocketSecret(publicSocket) : undefined;
	const internal = await createInternalSocketPath(paths.dir);
	const internalSocket = internal.socket;
	const internalSecretPath = internal.secretPath ?? socketSecretPath(internalSocket);
	const internalSecret = process.platform === "win32" ? await createSocketSecret(internalSecretPath) : undefined;
	const state: SupervisorState = {
		shuttingDown: false,
		shutdownReason: undefined,
		childExitRecorded: Promise.resolve(),
		publicSocketOwned: false,
		publicSocketIdentity: undefined,
		endpointReplaced: false,
	};
	const activity = new SupervisorActivity({
		idleExitMs: policy.coldStart === "persistent" ? Number.POSITIVE_INFINITY : policy.idleExitMs,
		internalSocket,
		...(internalSecret ? { internalSecret } : {}),
		settled: () => state.shuttingDown,
	});
	const watchers: Array<() => void> = [];

	const childLaunch = spawnableChildLaunch(resolveHostChildLaunch(launch, internalSocket));
	const child = spawn(childLaunch.command, childLaunch.args, {
		env: {
			...process.env,
			...(launch.agentDir ? { SENPI_CODING_AGENT_DIR: launch.agentDir } : {}),
			// The child binds a PRIVATE socket, so it cannot derive this endpoint's daemon directory
			// from what it listens on: it is told, and it claims its session paths there.
			[HOST_DAEMON_DIR_ENV]: paths.dir,
			[HOST_INSTANCE_ID_ENV]: instanceId,
			[HOST_WATCH_FD_ENV]: String(CHILD_WATCH_FD),
			[HOST_WATCH_PPID_ENV]: String(process.pid),
			...(internal.dir ? { [HOST_SCRATCH_DIR_ENV]: internal.dir } : {}),
			...(internalSecret ? { [SOCKET_SECRET_FILE_ENV]: internalSecretPath } : {}),
			[HOST_CLEANUP_PATHS_ENV]: hostCrashCleanupPaths({
				pointerFile: paths.pointerFile,
				generationPidFile: generation.pidFile,
				settingsFile: paths.settingsFile,
				publicSocket,
				successor: Boolean(successor),
				platform: process.platform,
			}).join("\n"),
			...(process.platform === "win32" ? {} : { [HOST_PUBLIC_SOCKET_ENV]: publicSocket }),
		},
		// Slot 3 is the lifetime pipe: "pipe" gives the child a read end it can
		// wait on and keeps the write end owned by this process alone.
		shell: childLaunch.shell,
		stdio: ["ignore", "ignore", "inherit", "pipe"],
		// The supervisor is spawned detached, so on win32 it owns no console. A
		// console-subsystem child started from it would allocate a fresh one,
		// which Windows Terminal renders as an empty window that takes focus.
		// CREATE_NO_WINDOW gives the child a console with no window instead.
		windowsHide: true,
	});
	const childStartedAt = Date.now();
	// Nothing is ever written; the pipe exists purely so its EOF is a reliable
	// death notification. Errors on it must not crash the supervisor.
	child.stdio[CHILD_WATCH_FD]?.on("error", () => {});
	// The CHILD's own identity, so a reader can tell "supervisor gone, child still running" apart.
	if (child.pid !== undefined) void recordChildPid(generation.childPidFile, child.pid);
	child.once("exit", (code, signal) => {
		// Recorded BEFORE any shutdown it triggers: `shutdown` ends in `process.exit`. A stop the
		// supervisor is performing itself is recorded too, as the engine stop it is.
		const reason = state.shutdownReason;
		state.childExitRecorded = noteChildExit({
			daemonDir: paths.dir,
			generation,
			instanceId,
			code,
			signal,
			childStartedAt,
			...(state.shuttingDown && reason !== undefined
				? { shutdown: { reason, supervisor: supervisorSender(instanceId) } }
				: {}),
		});
		if (state.shuttingDown) return;
		const verdict = classifyChildExit(code, signal);
		void state.childExitRecorded.then(() => shutdown(verdict.reason, verdict.exitCode));
	});

	const drain = new SupervisorDrain(child, () => state.shuttingDown);
	const server = createPublicProxy({
		internalSocket,
		...(internalSecret ? { internalSecret } : {}),
		...(publicSecret ? { publicSecret } : {}),
		clients: activity.clients,
		refusing: () => state.shuttingDown || drain.active,
		onDetach: () => activity.refresh(),
	});
	server.once("error", (cause) => {
		if (!state.shuttingDown) void shutdown(`public socket listener failed: ${errorMessage(cause)}`, 1);
	});
	const tickIntervalMs = Math.max(20, Math.min(1_000, policy.idleExitMs / 4));
	const ticker = setInterval(() => {
		if (!drain.active && activity.refresh() === "exit" && activity.clients.unclassifiedCount === 0)
			void shutdown("idle", 0);
	}, tickIntervalMs);
	watchers.push(() => clearInterval(ticker));

	const teardown: SupervisorShutdown = {
		paths,
		generation,
		instanceId,
		publicSocket,
		server,
		internalDir: internal.dir,
		child,
		activity,
		drain,
		state,
		stopWatchers: () => {
			for (const stop of watchers.splice(0)) stop();
		},
	};
	let shutdownPromise: Promise<never> | undefined;
	// Single-flight: concurrent triggers (listener error, child exit, signals) must not process.exit
	// mid-cleanup. Late callers park on this promise while the first shutdown finishes and exits.
	function shutdown(reason: string, exitCode: number): Promise<never> {
		shutdownPromise ??= performShutdown(teardown, reason, exitCode);
		return shutdownPromise;
	}

	// Registered before the startup handshake, not after it: the private internal directory already
	// exists, so a SIGTERM arriving during host startup must run the same cleanup instead of Node's
	// default kill, which would leave that directory behind.
	registerSupervisorSignals(shutdown, () => drain.drain());
	try {
		await waitForListener(internalSocket, 30_000, internalSecret);
		await activity.openObserver();
		await prepareSocketPath(bindSocket);
		await listen(server, bindSocket, publicSecret);
		state.publicSocketOwned = true;
		if (successor) await adoptPublicSocket(bindSocket, publicSocket, launch.replaceIdentity);
		state.publicSocketIdentity = await statSocketIdentity(publicSocket);
		// Publish the ownership token inside this supervisor's private scratch
		// directory (which no replacement supervisor writes): the host child's
		// crash-path cleanup compares the public path against THIS entry only.
		if (state.publicSocketIdentity && internal.dir) {
			await writeSocketIdentityFile(join(internal.dir, PUBLIC_SOCKET_IDENTITY_FILE), state.publicSocketIdentity);
		}
		watchers.push(
			drainOnPublicSocketLoss(
				publicSocket,
				state.publicSocketIdentity,
				() => state.shuttingDown || drain.active,
				drain,
				() => {
					state.endpointReplaced = true;
				},
			),
		);
	} catch (cause) {
		await shutdown(`startup failed: ${errorMessage(cause)}`, 1);
	}
	if (process.platform === "win32") {
		watchers.push(
			await watchWin32ChildIdentity(
				child,
				() => state.shuttingDown,
				() => void shutdown("rpc host child exit observed by identity watchdog", 0),
			),
		);
	}
	writeStderrLine(
		`senpi rpc host ready on unix://${publicSocket} (coldStart=${policy.coldStart}, idleExitMs=${
			policy.coldStart === "persistent" ? "never" : String(policy.idleExitMs)
		})`,
	);
	await new Promise<never>(() => {});
}

function isEntryScript(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return fileURLToPath(import.meta.url) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (!isBundledNode && isEntryScript()) {
	const launch = parseSupervisorArgs(process.argv.slice(2));
	if (!launch) {
		writeStderrLine("usage: host-lifecycle.ts --socket <path> [host cli args...]");
		process.exit(2);
	}
	void runHostSupervisor(launch);
}
