import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import { decodeBridgeFrame, isKernelToHostMessage } from "../../bridge/protocol.ts";
import { type CodemodeRuntimeAssetEnvironment, requireCodemodeRuntimeAsset } from "../shared/runtime-asset.ts";
import { type SubprocessLike, SubprocessProcess, spawnSubprocess } from "../shared/subprocess-process.ts";
import type { WorkerLike } from "./inline-worker.ts";
import { JavaScriptWorkerExitedError } from "./worker-host.ts";

const PROCESS_CLOSE_GRACE_MS = 2_000;

export interface JavaScriptProcessEntryUrlOptions extends CodemodeRuntimeAssetEnvironment {
	readonly localPath?: string;
}

export function resolveJsProcessEntryUrl(options: JavaScriptProcessEntryUrlOptions = {}): URL {
	const localPath = options.localPath ?? join(dirname(fileURLToPath(import.meta.url)), "process-entry.js");
	return pathToFileURL(requireCodemodeRuntimeAsset(localPath, join("kernels", "js", "process-entry.js"), options));
}

export class JavaScriptProcessRuntimeUnavailableError extends Error {
	readonly name = "JavaScriptProcessRuntimeUnavailableError";
	readonly runtime: string;
	readonly searchPath: string;

	constructor(runtime: string, searchPath: string) {
		super(
			`JavaScript runtime is unavailable: no ${runtime} executable found on PATH${searchPath.length === 0 ? " (empty)" : ""}. Install bun or node, or use isolation.js: "worker".`,
		);
		this.runtime = runtime;
		this.searchPath = searchPath;
	}
}

export interface JavaScriptProcessWorkerOptions {
	readonly cwd: string;
	readonly parallelPoolWidth: number;
	readonly searchPath?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly spawn?: (
		command: string,
		args: readonly string[],
		options: { cwd?: string; env?: NodeJS.ProcessEnv },
	) => SubprocessLike;
}

export interface JavaScriptProcessWorker extends WorkerLike {
	readonly pid?: number;
}

export function resolveJavaScriptProcessCommand(
	searchPath: string | undefined,
	platform: NodeJS.Platform = process.platform,
	hostRuntime: string = process.versions.bun === undefined ? "node" : "bun",
): string {
	const pathValue = searchPath ?? process.env.PATH ?? "";
	if (pathValue.trim().length === 0) throw new JavaScriptProcessRuntimeUnavailableError(hostRuntime, "");
	const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	const candidates = hostRuntime === "bun" ? ["bun", "node"] : ["node", "bun"];
	for (const directory of pathValue.split(platform === "win32" ? ";" : ":")) {
		if (directory.length === 0) continue;
		for (const name of candidates) {
			for (const extension of extensions) {
				const candidate = join(directory, `${name}${extension}`);
				try {
					require("node:fs").accessSync(candidate);
					return candidate;
				} catch {}
			}
		}
	}
	throw new JavaScriptProcessRuntimeUnavailableError(hostRuntime, pathValue);
}

export function spawnProcessWorker(url: URL, options: JavaScriptProcessWorkerOptions): JavaScriptProcessWorker {
	const command = resolveJavaScriptProcessCommand(options.searchPath);
	const isBun = /bun(\.exe)?$/.test(command);
	const args = isBun ? [fileURLToPath(url)] : ["--experimental-strip-types", fileURLToPath(url)];
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...options.env,
		SENPI_CODEMODE_PROCESS_CWD: options.cwd,
		SENPI_CODEMODE_PROCESS_POOL_WIDTH: String(options.parallelPoolWidth),
	};
	const child =
		options.spawn === undefined
			? spawnSubprocess(undefined, { command, args, cwd: options.cwd, env })
			: options.spawn(command, args, { cwd: options.cwd, env });
	const messageHandlers = new Set<(message: KernelToHostMessage) => void>();
	const errorHandlers = new Set<(error: Error) => void>();
	const subprocess = new SubprocessProcess(child, {
		onLine: (_process, line) => {
			const parsed = decodeBridgeFrame(line);
			if (!parsed.ok) {
				for (const handler of [...errorHandlers])
					handler(new Error(`JavaScript kernel process emitted an invalid frame: ${parsed.error.message}`));
				return;
			}
			if (!isKernelToHostMessage(parsed.message)) return;
			for (const handler of [...messageHandlers]) handler(parsed.message);
		},
		onStderr: () => {},
		onExit: (_process, code, signal) => {
			const error = new JavaScriptWorkerExitedError(code ?? -1, signal);
			for (const handler of [...errorHandlers]) handler(error);
		},
		onError: (_process, error) => {
			for (const handler of [...errorHandlers]) handler(error);
		},
	});
	return {
		mode: "process",
		get pid() {
			return child.pid;
		},
		postMessage(message) {
			subprocess.send(`${JSON.stringify(message)}\n`);
		},
		onMessage(handler) {
			messageHandlers.add(handler);
			return () => {
				messageHandlers.delete(handler);
			};
		},
		onError(handler) {
			errorHandlers.add(handler);
			return () => {
				errorHandlers.delete(handler);
			};
		},
		async terminate() {
			const exited = await subprocess.shutdown(`${JSON.stringify({ type: "close" })}\n`);
			if (!exited) await subprocess.terminate("SIGKILL", PROCESS_CLOSE_GRACE_MS);
		},
	};
}
