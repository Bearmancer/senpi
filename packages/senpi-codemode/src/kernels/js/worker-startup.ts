import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type CodemodeRuntimeAssetEnvironment, requireCodemodeRuntimeAsset } from "../shared/runtime-asset.ts";
import { createInlineWorker, type WorkerLike } from "./inline-worker.ts";
import { resolveKernelToolNameSource } from "./kernel-contract.ts";
import { type JavaScriptKernelOptions, localBridgeConnection } from "./local-module-loader.ts";
import { resolveJsProcessEntryUrl, spawnProcessWorker } from "./process-worker.ts";
import { spawnNodeWorker, WorkerStartupCancelledError, waitForReady } from "./worker-host.ts";

export interface JavaScriptWorkerEntryUrlOptions extends CodemodeRuntimeAssetEnvironment {
	readonly localPath?: string;
}

export function resolveJsWorkerEntryUrl(options: JavaScriptWorkerEntryUrlOptions = {}): URL {
	const localPath = options.localPath ?? join(dirname(fileURLToPath(import.meta.url)), "worker-entry.js");
	return pathToFileURL(requireCodemodeRuntimeAsset(localPath, join("kernels", "js", "worker-entry.js"), options));
}

export interface WorkerStartupHooks {
	readonly options: JavaScriptKernelOptions;
	readonly kernelGeneration: number;
	/** Wires the worker into the kernel; throws `WorkerStartupCancelledError` once the generation is stale. */
	publish(worker: WorkerLike): void;
	isCurrent(worker: WorkerLike): boolean;
	retire(worker: WorkerLike): void;
	canFallBackInline(): boolean;
}

export async function startWorkerWithInlineFallback(hooks: WorkerStartupHooks, signal: AbortSignal): Promise<void> {
	let worker = spawnWorker(hooks.options);
	hooks.publish(worker);
	try {
		await initializeWorker(worker, hooks, signal);
		return;
	} catch (error) {
		if (!hooks.isCurrent(worker) || error instanceof WorkerStartupCancelledError) {
			await worker.terminate();
			throw new WorkerStartupCancelledError();
		}
		// Process mode never falls back: the user asked for isolation, so a failed start stays visible.
		if (worker.mode === "inline" || worker.mode === "process") throw error;
		hooks.retire(worker);
		await worker.terminate();
	}
	if (!hooks.canFallBackInline()) throw new WorkerStartupCancelledError();
	worker = createInlineWorker(hooks.options.cwd, hooks.options.parallelPoolWidth);
	hooks.publish(worker);
	await initializeWorker(worker, hooks, signal);
}

function spawnWorker(options: JavaScriptKernelOptions): WorkerLike {
	if (options.isolation === "process") {
		const url = resolveJsProcessEntryUrl();
		return spawnProcessWorker(url, {
			cwd: options.cwd,
			parallelPoolWidth: options.parallelPoolWidth,
			...(options.processCommandPath === undefined ? {} : { searchPath: options.processCommandPath }),
			...(options.processExecPath === undefined ? {} : { execPath: options.processExecPath }),
		});
	}
	try {
		const url = options.workerEntryUrl ?? resolveJsWorkerEntryUrl();
		return spawnNodeWorker(url, options.cwd, options.parallelPoolWidth);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return createInlineWorker(options.cwd, options.parallelPoolWidth);
	}
}

async function initializeWorker(worker: WorkerLike, hooks: WorkerStartupHooks, signal: AbortSignal): Promise<void> {
	const ready = waitForReady(worker, signal);
	const options = hooks.options;
	worker.postMessage({
		type: "init",
		sessionId: options.sessionId,
		connection: localBridgeConnection(options),
		kernelGeneration: hooks.kernelGeneration,
		hostToolNames: resolveKernelToolNameSource(options.hostToolNames),
		foreignLanguageNames: resolveKernelToolNameSource(options.foreignLanguageNames),
		...(options.sessionEnv === undefined ? {} : { sessionEnv: options.sessionEnv }),
		...(options.memory === undefined ? {} : { memory: options.memory }),
		...(options.kernelToolsEnabled === false ? { kernelToolsDisabled: true } : {}),
	});
	await ready;
}
