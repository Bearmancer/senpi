/**
 * WHERE one socket's daemon keeps its state: the per-socket directory, the files inside it, and the
 * modes they are created with.
 *
 * Layout 2 gives every endpoint its own directory, named by the socket it serves:
 *
 *     <agentDir>/rpc-host-daemon/                 the flat directory - shared, and left legacy-empty
 *       layout.json                               { layout: 2, dir } - the only file this build writes here
 *       <sha256(canonical socket)[:16]>/          0700, one per endpoint
 *         endpoint.json                           { layout, registry_version, endpoint_kind, socket, created_at }
 *                                                 - WHICH socket this is, and what serves it
 *         host.pid                                POINTER: { layout, instance_id, generation_dir, writer }
 *         settings.json                           what the supervisor reads at boot
 *         daemon.lock  stderr.log
 *         generations/<instanceId>/               one per generation of this daemon
 *           host.pid  settings.json  scratch/
 *         reservations/                           cross-generation session-path claims
 *
 * The flat directory is deliberately missing the one file every DEPLOYED client looks for. A flat
 * `host.pid` holding `{ pid, processStartTime }` is exactly what arms their kill paths - the desktop's
 * `readManagedHost` -> takeover, and a pre-layout-2 `ensureHost` -> `stopManagedHost` - so writing one
 * would make an un-updated client replace this daemon and end every other client's sessions. Without
 * it both fail CLOSED: they see no host of their own, refuse, and leave the daemon alone. Nothing here
 * ever writes a legacy-shaped file, and nothing here ever removes one: a flat `host.pid` that DOES
 * exist belongs to a legacy host that may still be running, and is read-only to this build.
 *
 * `endpoint.json` is the endpoint's durable identity: written once and whole (linked into place), never
 * rewritten while it names this directory's socket (an ensure repairs one that does not), and the one file
 * a generation's release leaves behind - so an endpoint whose host exited (cleanly or not) can still
 * be enumerated and named. The pointer, `settings.json` and the generation directories all describe
 * a LIVE host and go with it. `endpoint_kind` says what serves the socket - a multi-session host
 * (`rpc_host`) or a terminal's control endpoint (`tui`) - and a record written before the field
 * existed is read as `rpc_host`; readers never rewrite one to add it.
 *
 * What those files CONTAIN is `host-daemon-state.ts` (settings, and the primitives every state file
 * is written through) and `host-daemon-registration.ts` (the pointer and the generation records).
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, win32 } from "node:path";
import { getAgentDir } from "../../config.ts";
import { canonicalSessionPath } from "./session-path-key.ts";

/** The layout this build writes. A directory without the marker predates it and is never touched. */
export const HOST_DAEMON_LAYOUT = 2;

/** Absolute daemon directory handed to a spawned host, which binds a private socket of its own. */
export const HOST_DAEMON_DIR_ENV = "SENPI_RPC_HOST_DAEMON_DIR";

/** The `endpoint.json` schema this build writes; readers accept any record that names its socket. */
export const ENDPOINT_REGISTRY_VERSION = 1;

/** What serves an endpoint: a multi-session RPC host, or an interactive terminal's control endpoint. */
export type EndpointKind = "rpc_host" | "tui";

const DIRECTORY_MODE = 0o700;
export const HOST_STATE_FILE_MODE = 0o600;

export interface HostDaemonPaths {
	/** The endpoint these paths belong to, exactly as its directory name was derived from. */
	readonly socket: string;
	/** `<agentDir>/rpc-host-daemon`: shared by every endpoint, and by any legacy host's own state. */
	readonly flatDir: string;
	/** The only file this build writes into the flat directory: `{ layout, dir }`. */
	readonly layoutMarker: string;
	/** A LEGACY host's registration. Read-only evidence that another host may be running. */
	readonly legacyPidFile: string;
	/** This endpoint's state directory, `<flatDir>/<sha256(canonical socket)[:16]>`. */
	readonly dir: string;
	/** Durable identity `{ layout, registry_version, endpoint_kind, socket, created_at }`: survives every generation's release. */
	readonly endpointFile: string;
	/** The pointer at the current generation. Deliberately unparseable as a legacy pidfile. */
	readonly pointerFile: string;
	/** Cross-version ensure lock for this endpoint (the endpoint lock itself lives in the temp dir). */
	readonly lockFile: string;
	readonly settingsFile: string;
	readonly stderrLog: string;
	readonly generationsDir: string;
	readonly reservationsDir: string;
}

/** The files inside one endpoint's directory, for a reader that has the directory but not its socket. */
export type HostDaemonDirectory = Omit<HostDaemonPaths, "socket" | "flatDir" | "layoutMarker" | "legacyPidFile">;

export interface HostGenerationPaths {
	readonly dir: string;
	/** Where the pointer names this generation: relative to the daemon directory holding it. */
	readonly relativeDir: string;
	readonly pidFile: string;
	readonly settingsFile: string;
	readonly scratchDir: string;
}

/**
 * The one spelling of an endpoint every client derives the same way. On POSIX that is the socket path
 * with its directory resolved through its deepest existing ancestor (`/tmp` vs `/private/tmp`, a
 * symlinked agent directory) - the identity the ensure lock is keyed by - and a path already spelled
 * that way comes back unchanged. On win32 it is the normalized lower-cased path the pipe name is derived
 * from. An abstract socket has no directory to resolve. Deliberately total: naming a directory must never
 * fail on a path shape the transport would reject, or a client could not even report WHERE it was looking.
 */
export function canonicalEndpointPath(socket: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return win32.normalize(socket).toLowerCase();
	if (socket.startsWith("\0")) return socket;
	return join(canonicalSessionPath(dirname(socket)), basename(socket));
}

/**
 * The directory name every client recomputes from the socket alone: `sha256(<canonical endpoint>)`, so
 * every spelling of one endpoint shares one directory, and a canonical spelling keeps the name it had
 * when the name was hashed from the spelling itself.
 */
export function daemonDirectoryName(socket: string, platform: NodeJS.Platform = process.platform): string {
	return directoryNameOf(canonicalEndpointPath(socket, platform));
}

/** Whether two spellings name one endpoint. */
export function sameEndpoint(socket: string, other: string): boolean {
	return socket === other || canonicalEndpointPath(socket) === canonicalEndpointPath(other);
}

/**
 * Whether a record naming `socket` belongs in the directory called `name`: the canonical name, or the
 * name a build that hashed the spelling itself gave it - that directory has to stay listable, and
 * therefore collectable by `host gc`, after the upgrade.
 */
export function socketNamesDirectory(socket: string, name: string): boolean {
	return daemonDirectoryName(socket) === name || (process.platform !== "win32" && directoryNameOf(socket) === name);
}

function directoryNameOf(endpoint: string): string {
	return createHash("sha256").update(endpoint, "utf8").digest("hex").slice(0, 16);
}

/**
 * The owner-keyed shard naming contract every client computes identically - senpi, omo (library
 * import) and the Desktop (a local mirror checked against `senpi host shard-path`): `p` shards belong
 * to a parent session, `i` shards to an interactive thread. The key is `sha256("<kind>:<owner>")` in
 * hex, first 16 characters; the socket is `<root>/<kind>-<key>.sock`.
 */
export type ShardKind = "p" | "i";

export function shardKey(kind: ShardKind, ownerId: string): string {
	return createHash("sha256").update(`${kind}:${ownerId}`, "utf8").digest("hex").slice(0, 16);
}

/** The socket of a shard whose key is already known. No hashing: the key IS the name. */
export function shardSocketPathForKey(root: string, kind: ShardKind, key: string): string {
	return join(root, `${kind}-${key}.sock`);
}

export function shardSocketPath(root: string, kind: ShardKind, ownerId: string): string {
	return shardSocketPathForKey(root, kind, shardKey(kind, ownerId));
}

const SHARD_SOCKET_NAME = /^(p|i)-([0-9a-f]{16})\.sock$/;

/** Which shard a socket names, from its basename alone; `null` for any other endpoint. */
export function parseShardSocket(socket: string): { readonly kind: ShardKind; readonly key: string } | null {
	const match = SHARD_SOCKET_NAME.exec(basename(socket));
	const key = match?.[2];
	if (key === undefined) return null;
	return { kind: match?.[1] === "i" ? "i" : "p", key };
}

/**
 * The daemon directory of ONE endpoint. Both fields are named rather than positional on purpose:
 * two strings in a row is exactly the call a refactor silently swaps, and swapping these two would
 * point a client at another socket's state.
 */
export function createHostDaemonPaths(target: {
	readonly socket: string;
	readonly agentDir?: string;
}): HostDaemonPaths {
	const flatDir = join(target.agentDir ?? getAgentDir(), "rpc-host-daemon");
	return {
		socket: target.socket,
		flatDir,
		layoutMarker: join(flatDir, "layout.json"),
		legacyPidFile: join(flatDir, "host.pid"),
		...hostDaemonDirectoryPaths(join(flatDir, daemonDirectoryName(target.socket))),
	};
}

/**
 * The files inside one endpoint's directory, for a caller that was TOLD the directory instead of
 * the socket it serves - a supervised host binds a private hop, so it cannot derive the endpoint.
 * The names live here alone, so the directory a client recomputes and the one a host is handed
 * can never drift apart.
 */
export function hostDaemonDirectoryPaths(dir: string): HostDaemonDirectory {
	return {
		dir,
		endpointFile: join(dir, "endpoint.json"),
		pointerFile: join(dir, "host.pid"),
		lockFile: join(dir, "daemon.lock"),
		settingsFile: join(dir, "settings.json"),
		stderrLog: join(dir, "stderr.log"),
		generationsDir: join(dir, "generations"),
		reservationsDir: join(dir, "reservations"),
	};
}

export function generationPaths(paths: HostDaemonDirectory, instanceId: string): HostGenerationPaths {
	const dir = join(paths.generationsDir, instanceId);
	return {
		dir,
		relativeDir: `generations/${instanceId}`,
		pidFile: join(dir, "host.pid"),
		settingsFile: join(dir, "settings.json"),
		scratchDir: join(dir, "scratch"),
	};
}

/** A daemon directory that cannot be created or written, named so the caller can say WHICH path failed. */
export class HostDaemonStateError extends Error {
	readonly path: string;

	constructor(path: string, cause: unknown) {
		super(`RPC daemon state directory ${path} is not usable: ${cause instanceof Error ? cause.message : cause}`, {
			cause,
		});
		this.name = "HostDaemonStateError";
		this.path = path;
	}
}

/**
 * Creates this endpoint's directories and publishes the flat marker. A directory that already exists
 * keeps whatever mode it was created with - and this one holds the evidence that decides who may
 * signal the daemon - so an existing one is re-moded explicitly; one `mkdir` just created already
 * has the mode. The siblings inside the endpoint directory and the marker are written concurrently.
 * A `tui` registrant passes its kind; everything else is an `rpc_host`.
 */
export async function createDaemonDirectories(
	paths: HostDaemonPaths,
	identity: { readonly kind?: EndpointKind } = {},
): Promise<void> {
	try {
		// The flat directory may predate this layout and may hold a legacy host's files: it is created
		// when missing and never re-moded, so a legacy host keeps whatever it set up for itself.
		await mkdir(paths.flatDir, { recursive: true, mode: DIRECTORY_MODE });
		await makePrivateDirectory(paths.dir);
		await Promise.all([
			makePrivateDirectory(paths.generationsDir),
			makePrivateDirectory(paths.reservationsDir),
			writeFile(
				paths.layoutMarker,
				`${JSON.stringify({ layout: HOST_DAEMON_LAYOUT, dir: basename(paths.dir) })}\n`,
				{ mode: HOST_STATE_FILE_MODE },
			),
		]);
	} catch (cause) {
		throw new HostDaemonStateError(paths.dir, cause);
	}
	await ensureEndpointIdentity(paths, paths.socket, identity);
}

/** `mkdir` names the directory it created; only one that already existed needs its mode set. */
async function makePrivateDirectory(directory: string): Promise<void> {
	const created = await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
	if (created === undefined) await chmod(directory, DIRECTORY_MODE);
}

/**
 * Writes `endpoint.json` when it is absent and never rewrites a valid one: the first writer's
 * `created_at` is the endpoint's birth. The file is written whole to a temporary name and LINKED
 * into place, so a reader never sees it half-written and a second writer racing the first loses on
 * the link rather than replacing it. `repair` - asserted only by an ensure under this socket's ensure
 * lock, where `gc` cannot be deciding about the directory - also replaces a file that does not name a
 * socket of this directory (torn by a crash of an older build, or foreign), which would otherwise
 * leave the endpoint unaddressable, and never `gc`-able, for good.
 *
 * A filesystem without hard links (exFAT/FAT, some network and FUSE mounts: `link()` fails with
 * ENOTSUP, EPERM, ENOSYS...) gets the exclusive create of the final file instead. That write is not
 * atomic, but the first writer still wins, and a file torn by a crash is exactly what `repair` rewrites.
 */
export async function ensureEndpointIdentity(
	paths: HostDaemonPaths,
	socket: string,
	options: { readonly repair?: boolean; readonly kind?: EndpointKind } = {},
): Promise<void> {
	const temporary = `${paths.endpointFile}.${process.pid}-${randomUUID()}.tmp`;
	try {
		await mkdir(paths.dir, { recursive: true, mode: DIRECTORY_MODE });
		const record = `${JSON.stringify({
			layout: HOST_DAEMON_LAYOUT,
			registry_version: ENDPOINT_REGISTRY_VERSION,
			endpoint_kind: options.kind ?? "rpc_host",
			socket,
			created_at: new Date().toISOString(),
		})}\n`;
		await writeFile(temporary, record, { mode: HOST_STATE_FILE_MODE, flag: "wx" });
		const placed = await link(temporary, paths.endpointFile).then(
			() => true,
			(cause: unknown) => (isErrorCode(cause, "EEXIST") ? false : createExclusively(paths.endpointFile, record)),
		);
		if (!placed && options.repair === true && !(await namesThisDirectory(paths))) {
			await rename(temporary, paths.endpointFile);
		}
	} catch (cause) {
		throw new HostDaemonStateError(paths.endpointFile, cause);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** The pre-link write: create the file only if absent. `false` when another writer got there first. */
async function createExclusively(path: string, content: string): Promise<boolean> {
	try {
		await writeFile(path, content, { mode: HOST_STATE_FILE_MODE, flag: "wx" });
		return true;
	} catch (cause) {
		if (isErrorCode(cause, "EEXIST")) return false;
		throw cause;
	}
}

function isErrorCode(cause: unknown, code: string): boolean {
	return cause instanceof Error && "code" in cause && cause.code === code;
}

async function namesThisDirectory(paths: HostDaemonPaths): Promise<boolean> {
	let record: unknown;
	try {
		record = JSON.parse(await readFile(paths.endpointFile, "utf8"));
	} catch {
		return false;
	}
	if (typeof record !== "object" || record === null || !("socket" in record)) return false;
	return (
		typeof record.socket === "string" &&
		record.socket !== "" &&
		socketNamesDirectory(record.socket, basename(paths.dir))
	);
}

/** Creates one generation's private directory. Same failure shape as the daemon directory itself. */
export async function createGenerationDirectory(generation: HostGenerationPaths): Promise<void> {
	try {
		await mkdir(generation.scratchDir, { recursive: true, mode: DIRECTORY_MODE });
		await chmod(generation.dir, DIRECTORY_MODE);
	} catch (cause) {
		throw new HostDaemonStateError(generation.dir, cause);
	}
}
