import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAgentDir } from "../../config.ts";
import {
	type DaemonPidFile,
	ProcessIdentityUnreadableError,
	processMatchesPidFile,
	readProcessStartTime,
} from "../app-server/daemon/process.ts";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	ensureEndpointIdentity,
	generationPaths,
	type HostDaemonPaths,
	sameEndpoint,
} from "./host-daemon-paths.ts";
import {
	clearHostRegistration,
	type RegisteredHost,
	readHostRegistration,
	writtenByThisProcess,
} from "./host-daemon-registration.ts";
import { decideHostAction, type HostDecision, HostEnsureRefusedError, type HostProtocolInfo } from "./host-decision.ts";
import { ensureClient } from "./host-ensure-client.ts";
import { hostEnsureLockOptions, hostEnsureLockTarget } from "./host-ensure-lock.ts";
import { appendStderr, reapOrphanedInternalHostDirs, startHost } from "./host-ensure-start.ts";
import { DEFAULT_STOP_TIMEOUT_MS, ensureSender, SIGKILL_GRACE_MS, stopManagedHost } from "./host-ensure-stop.ts";
import { HANDOFF_LOCK_HOLD_MS, handoffHostLocked } from "./host-handoff.ts";
import { retireIdleLegacyHost } from "./host-legacy.ts";
import type { HostColdStart, HostLifecyclePolicyInput } from "./host-lifecycle-policy.ts";
import { holdProtocolInfo, probeSocketReachable } from "./host-probe.ts";
import { isHostGenerationProcess } from "./host-process-role.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";
import { statSocketIdentity } from "./socket-ownership.ts";

export {
	createHostDaemonPaths,
	daemonDirectoryName,
	type HostDaemonPaths,
	HostDaemonStateError,
	type HostGenerationPaths,
} from "./host-daemon-paths.ts";
export { hostEnsureLockTarget } from "./host-ensure-lock.ts";
export { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
export { type ProbeHostOptions, probeHost } from "./host-probe.ts";
export type { HostColdStart, HostLifecyclePolicyInput };

/**
 * What an ensure may do to a host that is already running.
 *
 * `never` (the default) attaches or starts, and touches nothing that is already serving the
 * socket. `if-engine-differs` additionally allows a GENERATION HANDOFF when `decideHostAction`
 * finds this build strictly newer and its extension set a superset of the running host's - the
 * running host then drains instead of dying, so no session is ever ended by an upgrade.
 */
export type HostUpgradePolicy = "never" | "if-engine-differs";

export interface EnsureHostOptions {
	readonly socket: string;
	readonly agentDir?: string;
	/** Host lifecycle policy recorded in settings.json (env overrides win at runtime). */
	readonly policy?: HostLifecyclePolicyInput;
	/** Extra CLI arguments forwarded through the supervisor to the host process. */
	readonly hostArgs?: readonly string[];
	/** Environment for the spawned host; a `null` value removes an inherited variable. */
	readonly env?: Readonly<Record<string, string | null>>;
	/** Whether a newer build may take the socket over from the running host. Defaults to `never`. */
	readonly upgrade?: HostUpgradePolicy;
	readonly _test?: {
		readonly readinessTimeoutMs?: number;
		readonly stopTimeoutMs?: number;
		readonly spawn?: { readonly command: string; readonly args: readonly string[] };
		/** Builds the spawnable command from supervisor argv; tests point it at the source entry. */
		readonly launch?: (args: readonly string[]) => { readonly command: string; readonly args: readonly string[] };
		/** Runs after endpoint ownership is locked; deterministic concurrency-test gate. */
		readonly afterLockAcquired?: () => Promise<void>;
		/**
		 * Runs after the child is spawned but before its pidfile is registered, so a
		 * test can force the startup failure a loaded runner produces without having
		 * to stall the real process-identity probe.
		 */
		readonly beforePidFileWrite?: () => Promise<void>;
		/** Runs after readiness failed and before the start is torn down; deterministic teardown-test gate. */
		readonly beforeReadinessTeardown?: () => Promise<void>;
		/** Overrides the process-identity probe so a test can force its failure. */
		readonly readProcessStartTime?: (pid: number) => Promise<string | undefined>;
	};
}

export interface EnsuredHost {
	readonly pid: number;
	readonly socket: string;
	readonly reused: boolean;
	/**
	 * Ends this ensure's attach hold (host-attach-hold.ts). Until then the host counts this client as
	 * attached, so its idle window cannot close before the client's own connection is up; release it
	 * once that connection is attached, or when the client no longer needs the host.
	 */
	readonly release: () => void;
}

const EXISTING_HOST_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
/**
 * A lock waiter must outlast the longest critical section a holder can run:
 * probing an existing host, then either stopping an incompatible one (SIGTERM wait
 * plus the SIGKILL grace) and spawning the replacement and waiting for it to answer,
 * or handing it off (an upgrade) - which is also as long as a forced handoff holds it.
 * Each SQLite busy wait stays short because it blocks the event loop; this
 * cumulative budget is what covers the whole section, with headroom for a slow
 * runner. A waiter that gives up early surfaces as a raw "database is locked"
 * failure on the second of two concurrent starts.
 */
const ENSURE_LOCK_WAIT_MS =
	EXISTING_HOST_PROBE_TIMEOUT_MS +
	Math.max(DEFAULT_STOP_TIMEOUT_MS + SIGKILL_GRACE_MS + DEFAULT_READINESS_TIMEOUT_MS, HANDOFF_LOCK_HOLD_MS) +
	10_000;
const lockOptions = hostEnsureLockOptions(ENSURE_LOCK_WAIT_MS);
export async function ensureHost(options: EnsureHostOptions): Promise<EnsuredHost> {
	const socket = normalizeSocketPath(options.socket);
	const paths = createHostDaemonPaths({ socket, ...(options.agentDir ? { agentDir: options.agentDir } : {}) });
	await createDaemonDirectories(paths);
	// The public socket is the shared resource; agent directories are not a
	// sufficient lock scope when two installations target the same endpoint.
	const lockTarget = hostEnsureLockTarget(socket);
	await mkdir(dirname(lockTarget), { recursive: true });
	await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
	// Opportunistic GC of other installs' leftovers stays OUTSIDE the endpoint lock.
	// Its cost scales with the whole tmpdir and, on win32, adds a ~1s process probe per
	// candidate; inside the critical section that inflated the hold for every concurrent
	// ensureHost until a waiter exhausted its budget and surfaced a raw "database is
	// locked". Its own guards (60s age, dead owner pid) already make it safe unlocked.
	await reapOrphanedInternalHostDirs();
	const release = await acquireOwnershipSafeLock(`${lockTarget}.lock`, lockOptions);
	try {
		await options._test?.afterLockAcquired?.();
		return await ensureHostLocked(paths, socket, options);
	} finally {
		await release();
	}
}

async function ensureHostLocked(
	paths: HostDaemonPaths,
	socket: string,
	options: EnsureHostOptions,
): Promise<EnsuredHost> {
	// Under the lock, so a torn or foreign `endpoint.json` is repaired rather than left unaddressable.
	await ensureEndpointIdentity(paths, socket, { repair: true });
	const testOptions = options._test;
	const registered = await readHostRegistration(paths);
	// A record naming ANOTHER endpoint is not about this ensure's host. The per-socket directory
	// makes that structural, and the field stays as the second guard for a directory that was
	// somehow reused: a second socket must never read the first socket's daemon as its own.
	const registeredHere = registersSocket(registered, socket);
	// A reusable host is held from the connection that proved it compatible, never re-probed later.
	const held = await holdProtocolInfo(socket, EXISTING_HOST_PROBE_TIMEOUT_MS);
	const protocol = held?.info;
	const startedByUs =
		registeredHere && (await writtenByThisProcess(registered?.writer, testOptions?.readProcessStartTime));
	const attachedPid = registeredHere ? (registered?.record.pid ?? 0) : 0;
	const decision = decide(options, startedByUs, protocol);
	if (decision.action === "reuse" && held) {
		// A compatible socket is attachable even when another client surface
		// started it. Only hosts we spawned are eligible for lifecycle management.
		return { pid: attachedPid, socket, reused: true, release: held.hold.release };
	}
	held?.hold.release();
	switch (decision.action) {
		case "reuse":
			throw new Error(`host at ${socket} was reused without answering its probe`);
		case "refuse":
			throw new HostEnsureRefusedError(socket, decision.reason, protocol);
		case "handoff":
			return upgradeGeneration(paths, socket, options, attachedPid);
		case "start":
			break;
		default:
			return assertNever(decision);
	}
	const probe = testOptions?.readProcessStartTime ?? readProcessStartTime;
	const pidMatches = registeredHere && registered ? await matchesPidFileOrUnknown(registered.record, probe) : false;
	// The generation this start leaves RUNNING beside the new one, when there is one.
	let stranded: RegisteredHost | undefined;
	if (registered && pidMatches) {
		if (!startedByUs) {
			// I1: the socket is silent, but the process behind it is alive. Only the process that WROTE
			// this record may end it - anyone else refuses rather than signalling somebody else's host.
			if (await publicEndpointAccepts(socket)) throw new HostEnsureRefusedError(socket, "foreign_writer", protocol);
			// A foreign record whose public endpoint accepts NOTHING names a generation nobody can reach:
			// its entry was replaced (so it is already draining, #1893) or removed, or a dead listener
			// left the entry behind. Refusing here locked every client out until that process happened
			// to exit (#1936). Binding a fresh generation there signals nothing, so that is what happens -
			// the stranded one keeps its record.
			stranded = registered;
		} else {
			// Silent is not the same as gone. A host serving many sessions can miss a probe budget
			// while its event loop is busy; its socket still ACCEPTS the connection. Ending it then
			// would destroy every live session to replace a host that was never broken, so a
			// reachable socket is refused instead of signalled - the caller retries or falls back.
			if (await probeSocketReachable(socket, EXISTING_HOST_PROBE_TIMEOUT_MS)) {
				throw new HostEnsureRefusedError(socket, "host_busy", protocol);
			}
			await stopManagedHost(
				registered.record,
				testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
				{
					daemonDir: paths.dir,
					generation: generationPaths(paths, registered.instanceId),
					instanceId: registered.instanceId,
					sender: ensureSender(),
					reason: "replace_unreachable",
				},
				probe,
			);
		}
	}
	// A host from before this layout registered itself in the FLAT directory. Its files are another
	// process's state: never read as ours, never removed. While it is alive this ensure never starts
	// beside it: an idle one is drained and waited out (#2423), a busy or unprovable one is refused.
	const legacyRefusal = await retireIdleLegacyHost(
		paths,
		probe,
		testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
	);
	if (legacyRefusal !== undefined) throw new HostEnsureRefusedError(socket, "legacy_host", protocol, legacyRefusal);
	if (stranded !== undefined) return startHost(paths, socket, options, stranded.generation + 1);
	if (registeredHere) await clearHostRegistration(paths);
	return startHost(paths, socket, options);
}

/**
 * Only the connect matters here, never an answer: the kernel completes it from the listen backlog
 * without the host's event loop, so a live owner under load still accepts within this budget.
 */
const FOREIGN_ENDPOINT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether SOMETHING still accepts connections at the public path - the one fact that says a
 * registered process may still own the endpoint. A missing entry and an entry nobody listens
 * behind (connection refused) both answer no; an accepted connection, however silent, answers yes.
 * A named pipe has no entry to lose and an abstract socket has no path, so both read as owned;
 * so does an entry this process cannot stat, because an owner that cannot be ruled out is one
 * this ensure must not bind over.
 */
async function publicEndpointAccepts(socket: string): Promise<boolean> {
	if (process.platform === "win32" || socket.startsWith("\0")) return true;
	const entry = await statSocketIdentity(socket).then(
		(identity) => (identity === undefined ? "absent" : "present"),
		() => "unknown",
	);
	if (entry === "absent") return false;
	if (entry === "unknown") return true;
	return probeSocketReachable(socket, FOREIGN_ENDPOINT_PROBE_TIMEOUT_MS);
}

/** `fallback` belongs to clients that can live without a host; an ensure must produce one or fail. */
function decide(
	options: EnsureHostOptions,
	startedByUs: boolean,
	protocol: HostProtocolInfo | undefined,
): Exclude<HostDecision, { action: "fallback" }> {
	if (options.upgrade !== "if-engine-differs" || isHostGenerationProcess()) {
		return decideHostAction(ensureClient(options, startedByUs), protocol, "never");
	}
	const decision = decideHostAction(ensureClient(options, startedByUs), protocol, "upgrade");
	return decision.action === "fallback" ? { action: "reuse", reason: "compatible", upgradeable: false } : decision;
}

/**
 * The upgrade, when the decision allows one: a new generation takes the socket and the running
 * host drains. A refused handoff ATTACHES - an upgrade that cannot happen must never become a stop.
 */
async function upgradeGeneration(
	paths: HostDaemonPaths,
	socket: string,
	options: EnsureHostOptions,
	attachedPid: number,
): Promise<EnsuredHost> {
	const result = await handoffHostLocked({
		socket,
		agentDir: options.agentDir ?? getAgentDir(),
		hostArgs: options.hostArgs ?? [],
		...(options.env ? { env: options.env } : {}),
		...(options.policy ? { policy: options.policy } : {}),
		_test: {
			...(options._test?.launch ? { launch: options._test.launch } : {}),
			...(options._test?.readinessTimeoutMs ? { readinessTimeoutMs: options._test.readinessTimeoutMs } : {}),
		},
	});
	if (result.action === "handoff")
		return { pid: result.pid, socket, reused: false, release: await holdEnsured(socket) };
	await appendStderr(
		paths,
		`generation handoff refused: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`,
	);
	return { pid: attachedPid, socket, reused: true, release: await holdEnsured(socket) };
}

/** The attach hold for a host another step already proved ready (a handoff successor, a refused handoff). */
async function holdEnsured(socket: string): Promise<() => void> {
	const held = await holdProtocolInfo(socket, EXISTING_HOST_PROBE_TIMEOUT_MS);
	if (!held) throw new Error(`RPC socket host at ${socket} stopped answering before this ensure could hold it`);
	return held.hold.release;
}

/** Whether a registration is about this endpoint. A record written before the field existed is. */
function registersSocket(registered: RegisteredHost | undefined, socket: string): boolean {
	if (registered === undefined) return false;
	return registered.socket === undefined || sameEndpoint(registered.socket, socket);
}

/**
 * Ownership for the reuse decision. An identity we cannot read proves nothing: it can neither
 * claim the host nor authorize a kill, so it reads as "not ours" and the caller starts fresh
 * rather than failing the whole ensure on an observation gap.
 */
async function matchesPidFileOrUnknown(
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

function normalizeSocketPath(value: string): string {
	if (value.startsWith("unix://")) return value.slice("unix://".length);
	return value;
}

function assertNever(value: never): never {
	throw new Error(`unreachable host decision: ${JSON.stringify(value)}`);
}
