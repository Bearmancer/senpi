/**
 * WHAT the lifecycle supervisor is launched with and WHAT it launches: its hidden argv route, the
 * argv it parses, and the host child command it resolves. Split out of `host-lifecycle.ts`, which
 * keeps the supervisor's orchestration; every name stays re-exported there for existing importers.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBunBinary, isBundledNode } from "../../config.ts";
import { readProcessStartTime } from "../app-server/daemon/process.ts";
import { rpcHostExecArgv } from "./host-exec-argv.ts";
import { writeJsonAtomic } from "./host-state-json.ts";
import { errorMessage, supervisorLog } from "./host-supervisor-log.ts";
import type { SocketFileIdentity } from "./socket-ownership.ts";

/**
 * The internal hop must stay short enough for sun_path (104 bytes on macOS)
 * regardless of where the public socket lives, and private against other local
 * users, so it gets its own 0700 directory under the OS temp directory.
 *
 * On win32 the directory lives under the caller-supplied rpc-host-daemon
 * directory, which ensureHost() creates but a direct --internal-rpc-host-supervisor
 * launch does not, so the parent is created recursively.
 */
export async function createInternalSocketPath(
	baseDir = tmpdir(),
	platform: NodeJS.Platform = process.platform,
): Promise<{ socket: string; dir?: string; secretPath?: string }> {
	if (platform === "win32") {
		const dir = join(baseDir, `internal-${randomUUID()}`);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return {
			socket: `\\\\.\\pipe\\senpi-rpc-internal-${randomUUID()}`,
			dir,
			secretPath: join(dir, "secret"),
		};
	}
	const dir = join(tmpdir(), `senpi-rpc-host-internal-${randomUUID().slice(0, 8)}`);
	await mkdir(dir, { recursive: false, mode: 0o700 });
	await writeFile(
		join(dir, ".owner"),
		JSON.stringify({
			pid: process.pid,
			processStartTime: await readProcessStartTime(process.pid),
			createdAt: Date.now(),
		}),
		{ mode: 0o600 },
	);
	return { socket: join(dir, "host.sock"), dir, secretPath: join(dir, ".secret") };
}

export interface SupervisorLaunch {
	readonly socket: string;
	readonly hostArgs: readonly string[];
	/** Optional runtime command used by rebranded/bundled callers. */
	readonly childCommand?: string;
	readonly childArgs?: readonly string[];
	/** Explicit ownership directory for callers whose environment is not yet branded. */
	readonly agentDir?: string;
	/**
	 * Where this supervisor BINDS, when it is a successor generation: `<socket>.next-<gen>`.
	 * It renames that entry over `socket` once its host answers - and never binds the live
	 * public path, which belongs to the generation currently serving it.
	 */
	readonly bindSocket?: string;
	/**
	 * The public socket entry this generation is allowed to replace (`<dev>:<ino>`). The rename
	 * happens only while the path still refers to it: a socket that changed underneath belongs to
	 * somebody else now, and replacing it would unlink an endpoint this process cannot prove it owns.
	 */
	readonly replaceIdentity?: SocketFileIdentity;
}

/** Hidden internal launch route: wire-invisible, never advertised by the public CLI surface. */
export const INTERNAL_SUPERVISOR_FLAG = "--internal-rpc-host-supervisor";

/**
 * Engine-global flags a rebranded wrapper may legitimately prepend when it
 * re-dispatches this binary. `packages/omo-native` injects `--extension <dir>`
 * for every non-early command, which pushed the sentinel off argv[0].
 */
const INJECTABLE_PREFIX_FLAGS = new Set(["--extension"]);

/**
 * Returns the internal supervisor payload when argv selects that route.
 *
 * The route dispatches when the sentinel is argv[0] OR is preceded only by
 * known injectable prefix flags and their values - the one perturbation
 * wrappers legitimately perform. Everything else disqualifies it: a positional
 * operand, `--`, or an unknown flag before the sentinel all return undefined,
 * so a user-supplied value that happens to equal the sentinel can never reach
 * the supervisor.
 *
 * The skipped prefix is deliberately NOT forwarded to the host: a wrapper
 * re-injects its own prefix on every re-entry, so the host child receives it
 * from the wrapper rather than twice from here.
 */
export function findInternalSupervisorArgs(argv: readonly string[]): readonly string[] | undefined {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === INTERNAL_SUPERVISOR_FLAG) return argv.slice(index + 1);
		// A prefix flag only counts when its value is actually present.
		if (!INJECTABLE_PREFIX_FLAGS.has(arg) || index + 1 >= argv.length) return undefined;
		index++;
	}
	return undefined;
}

/** `--socket <path>` selects the public socket; every other argument is forwarded to the host CLI. */
export function parseSupervisorArgs(argv: readonly string[]): SupervisorLaunch | undefined {
	const hostArgs: string[] = [];
	let socket: string | undefined;
	let childCommand: string | undefined;
	let childArgs: readonly string[] | undefined;
	let agentDir: string | undefined;
	let bindSocket: string | undefined;
	let replaceIdentity: SocketFileIdentity | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--socket" && index + 1 < argv.length) {
			socket = argv[++index];
			continue;
		}
		if (arg === "--child-command" && index + 1 < argv.length) {
			childCommand = argv[++index];
			continue;
		}
		if (arg === "--child-args" && index + 1 < argv.length) {
			try {
				const parsed: unknown = JSON.parse(argv[++index]);
				if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) childArgs = parsed;
			} catch {
				return undefined;
			}
			continue;
		}
		if (arg === "--agent-dir" && index + 1 < argv.length) {
			agentDir = argv[++index];
			continue;
		}
		if (arg === "--bind" && index + 1 < argv.length) {
			bindSocket = argv[++index];
			continue;
		}
		if (arg === "--replace" && index + 1 < argv.length) {
			replaceIdentity = parseSocketIdentity(argv[++index]);
			continue;
		}
		hostArgs.push(arg);
	}
	return socket === undefined
		? undefined
		: { socket, hostArgs, childCommand, childArgs, agentDir, bindSocket, replaceIdentity };
}

/** `<dev>:<ino>` as the ensure captured it; anything else is no identity at all, never a guess. */
function parseSocketIdentity(value: string): SocketFileIdentity | undefined {
	const match = /^(\d+):(\d+)$/.exec(value);
	return match ? { dev: Number(match[1]), ino: Number(match[2]) } : undefined;
}

/**
 * Resolves the committed CLI entry this supervisor wraps (source tree or built dist).
 * Exported for tests, which pass the module path and layout of a bundled install.
 */
export function resolveCliMainPath(
	modulePath: string = fileURLToPath(import.meta.url),
	bundled: boolean = isBundledNode,
): string {
	// Bundled, take the entry from the package's own declared bin: the bundle's cli.js beside
	// this chunk, so a host started from a runtime snapshot runs the snapshot's copy and claims
	// it the way a session does (#2409). Counting ".." instead lands on dist/cli-main.js, the
	// unbundled tree the package also ships, which a snapshot links back to the install that an
	// upgrade replaces, or on the package root, where no cli-main was ever emitted.
	const declared = bundled ? resolveDeclaredCliEntry(modulePath) : undefined;
	if (declared !== undefined) return declared;
	const extension = modulePath.endsWith(".ts") ? ".ts" : ".js";
	const unbundled = resolve(dirname(modulePath), "..", "..", `cli-main${extension}`);
	if (existsSync(unbundled)) return unbundled;
	// Falls back to the old path when nothing is declared, so a caller that was working keeps working.
	return resolveDeclaredCliEntry(modulePath) ?? unbundled;
}

/** The CLI entry declared by the nearest enclosing package.json, when it exists on disk. */
function resolveDeclaredCliEntry(modulePath: string): string | undefined {
	let dir = dirname(modulePath);
	for (let depth = 0; depth < 8; depth += 1) {
		const manifestPath = resolve(dir, "package.json");
		if (existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
					bin?: Record<string, string> | string;
				};
				const declared = manifest.bin;
				const candidates = typeof declared === "string" ? [declared] : Object.values(declared ?? {});
				for (const candidate of candidates) {
					const entry = resolve(dir, candidate);
					if (existsSync(entry)) return entry;
				}
			} catch {}
			return undefined;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/**
 * Resolves the host child spawn. Explicit child commands (desktop launchers)
 * are forwarded untouched. The default re-enters the committed CLI entry
 * through the runtime, except in compiled standalone binaries, which always
 * boot their embedded entrypoint and would parse a script path as CLI
 * arguments - there the executable itself is the CLI, so the mode flags are
 * passed directly. Exported for tests.
 */
export function resolveHostChildLaunch(
	launch: SupervisorLaunch,
	internalSocket: string,
	compiled: boolean = isBunBinary,
): { command: string; args: string[] } {
	if (launch.childCommand) {
		return {
			command: launch.childCommand,
			args: [...(launch.childArgs ?? []), "--listen", `unix://${internalSocket}`],
		};
	}
	return {
		command: process.execPath,
		args: [
			...(compiled ? [] : [...rpcHostExecArgv(), resolveCliMainPath()]),
			"--mode",
			"rpc",
			"--multi-session",
			"--listen",
			`unix://${internalSocket}`,
			...launch.hostArgs,
		],
	};
}

/** Mirrors cross-spawn: survives cmd.exe parsing and `CommandLineToArgvW`. */
function quoteWindowsShellArg(value: string): string {
	const escaped = value
		.replace(/(\\*)"/g, '$1$1\\"')
		.replace(/(\\*)$/, "$1$1")
		.replace(/([()%!^"<>&|;,])/g, "^$1");
	return `"${escaped}"`;
}

/**
 * Windows refuses to spawn a `.cmd`/`.bat` without a shell, and Node's
 * `shell: true` concatenates argv without escaping it. Escape each original
 * value before adding the surrounding quotes so `.cmd`/`.bat` launchers survive
 * cmd.exe parsing without double-escaping.
 * Exported for tests.
 */
export function spawnableChildLaunch(
	launch: { command: string; args: string[] },
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
	const extension = extname(launch.command).toLowerCase();
	if (platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) {
		return { ...launch, shell: false };
	}
	return {
		command: quoteWindowsShellArg(launch.command),
		args: launch.args.map(quoteWindowsShellArg),
		shell: true,
	};
}

/** Best-effort, 0600, by rename; released with the generation directory. */
export async function recordChildPid(file: string, pid: number): Promise<void> {
	try {
		const processStartTime = (await readProcessStartTime(pid).catch(() => undefined)) ?? null;
		await writeJsonAtomic(file, { pid, processStartTime });
	} catch (cause) {
		supervisorLog(`could not record the host child pid: ${errorMessage(cause)}`);
	}
}

export async function readSettingsFile(settingsFile: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(settingsFile, "utf8"));
	} catch {
		return undefined;
	}
}
