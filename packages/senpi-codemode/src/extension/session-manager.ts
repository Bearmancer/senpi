import { join } from "node:path";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import { type BridgeServerHandle, startBridgeServer } from "../bridge/http-server.ts";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import { isReservedToolName, runReservedTool } from "../bridges/reserved-dispatch.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { resolveKernelMemoryThresholds } from "../config/memory-settings.ts";
import { defaultCodemodeSettings } from "../config/settings.ts";
import { collectOrphanedChildren } from "../host-sdk.ts";
import { JavaScriptKernel } from "../kernels/js/context-manager.ts";
import type { KernelLifecycle } from "../kernels/shared/kernel-death.ts";
import { marshalToolResult } from "../tool/image.ts";
import type { EvalKernel, EvalLanguage } from "../tool/types.ts";
import {
	javaScriptKernelMemory,
	registerKernel,
	type StartedKernel,
	startSubprocessKernel,
} from "./kernel-registration.ts";
import { kernelRegistry, type RegisteredKernelSource } from "./kernel-registry.ts";
import { ReplaceableKernel } from "./kernel-replacement.ts";
import { assertSessionCwdAvailable } from "./session-cwd.ts";
import type {
	BridgeEndpoint,
	CodemodeSessionManager,
	CreateCodemodeSessionManagerOptions,
} from "./session-manager-contract.ts";

export type {
	BridgeEndpoint,
	CodemodeSessionManager,
	CreateCodemodeSessionManagerOptions,
	EvalExecutionTracker,
} from "./session-manager-contract.ts";

export async function createCodemodeSessionManager(
	options: CreateCodemodeSessionManagerOptions,
): Promise<CodemodeSessionManager> {
	const manager = new DefaultCodemodeSessionManager(options);
	await manager.start();
	return manager;
}

export class CodemodeSessionDisposedError extends Error {
	readonly name = "CodemodeSessionDisposedError";

	constructor() {
		super("codemode session manager is disposed");
	}
}

class CodemodeContextUnavailableError extends Error {
	readonly name = "CodemodeContextUnavailableError";

	constructor() {
		super("codemode completion context is unavailable");
	}
}

class DefaultCodemodeSessionManager implements CodemodeSessionManager {
	readonly #options: CreateCodemodeSessionManagerOptions;
	#bridge: BridgeServerHandle | undefined;
	#kernels = new Map<EvalLanguage, EvalKernel>();
	readonly #registrations = new Map<EvalLanguage, string>();
	#kernelCreations = new Map<EvalLanguage, Promise<EvalKernel>>();
	#onMessageRefs = new Map<EvalLanguage, (message: KernelToHostMessage) => void>();
	#context: ExtensionContext | undefined;
	#generation = 0;
	#disposePromise: Promise<void> | undefined;

	constructor(options: CreateCodemodeSessionManagerOptions) {
		this.#options = options;
	}

	async start(): Promise<void> {
		this.#bridge = await startBridgeServer({
			onCall: async (request) => await this.#call(request),
			onEmit: async () => undefined,
			onCompletion: async (request) =>
				this.#options.complete({ prompt: request.prompt, opts: request.opts }, this.#contextFor(request.signal)),
		});
	}

	// Subprocess kernels (py/rb/jl) reach the host only through this route, so every reply
	// must match the in-process JS path in tool/cell-handler.ts: reserved helper names dispatch
	// through runReservedTool (forwarding them made agent() fail with "Unknown tool __agent__"),
	// and ordinary tool results are marshalled to { text, images, details, hasError } — the raw
	// { content } shape left python cells unable to reach tool.read image blocks.
	async #call(request: { toolName: string; args: unknown; callId: string; signal: AbortSignal }): Promise<unknown> {
		if (!isReservedToolName(request.toolName)) {
			return marshalToolResult(
				await this.#options.executeTool(request.toolName, request.args, { signal: request.signal }),
			);
		}
		const taskTools = this.#options.settings.taskTools ?? defaultCodemodeSettings.taskTools;
		return await runReservedTool(request.toolName, {
			callId: request.callId,
			args: request.args,
			executeTool: this.#options.executeTool,
			taskToolName: taskTools.task,
			taskOutputToolName: taskTools.output,
			listTools: this.#options.listTools,
			signal: request.signal,
			emitStatus: () => {},
			marshalToolResult,
		});
	}

	async getKernel(language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel> {
		if (this.#disposePromise) throw new CodemodeSessionDisposedError();
		// Persistent kernels are reused across cells, but each cell needs its OWN
		// onMessage (bound to that cell's streaming state). Rebind on every call via
		// a stable dispatcher so the 2nd+ cell's text/display/log output is attributed
		// to the current cell, not the one that first created the kernel.
		this.#onMessageRefs.set(language, onMessage);
		const existing = this.#kernels.get(language);
		if (existing) {
			await assertSessionCwdAvailable(this.#options.cwd);
			return existing;
		}
		const pending = this.#kernelCreations.get(language);
		if (pending) return await pending;
		// A bound method, never a closure in this frame: the dispatcher outlives every
		// cell, and a closure here would capture this call's lexical environment — under
		// JSC that keeps the creating cell's onMessage (CellHandler, output buffers,
		// display images) alive for the whole kernel generation (#2260).
		const dispatch = this.#dispatchTo.bind(this, language);
		const generation = this.#generation;
		const creation = this.#createAndStoreKernel(language, dispatch, generation);
		this.#kernelCreations.set(language, creation);
		try {
			return await creation;
		} finally {
			if (this.#kernelCreations.get(language) === creation) this.#kernelCreations.delete(language);
		}
	}

	releaseKernelListener(language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void): void {
		// Identity-checked: a cell settling late must not unbind a newer cell that already re-registered.
		if (this.#onMessageRefs.get(language) === onMessage) this.#onMessageRefs.delete(language);
	}

	#dispatchTo(language: EvalLanguage, message: KernelToHostMessage): void {
		this.#onMessageRefs.get(language)?.(message);
	}

	async complete(request: CompletionRequest, ctx: ExtensionContext): Promise<CompletionResult> {
		return await this.#options.complete(request, ctx);
	}

	bridgeEndpoint(): BridgeEndpoint {
		const bridge = this.#bridge;
		if (!bridge) throw new Error("codemode bridge server is not running");
		return { port: bridge.port, token: bridge.token };
	}

	setContext(ctx: ExtensionContext): void {
		this.#context = ctx;
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#generation++;
		this.#disposePromise = this.#disposeGeneration();
		return this.#disposePromise;
	}

	async #disposeGeneration(): Promise<void> {
		await Promise.allSettled(this.#kernelCreations.values());
		const kernels = [...this.#kernels.values()];
		const bridge = this.#bridge;
		this.#kernels.clear();
		for (const id of this.#registrations.values()) kernelRegistry.unregister(id);
		this.#registrations.clear();
		this.#onMessageRefs.clear();
		this.#bridge = undefined;
		this.#context = undefined;
		const failures: unknown[] = [];
		for (const outcome of await Promise.allSettled(kernels.map((kernel) => kernel.close()))) {
			if (outcome.status === "rejected") failures.push(outcome.reason);
		}
		if (bridge) {
			const [outcome] = await Promise.allSettled([bridge.close()]);
			if (outcome?.status === "rejected") failures.push(outcome.reason);
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "Failed to dispose codemode session manager");
		}
	}

	async #createAndStoreKernel(
		language: EvalLanguage,
		onMessage: (message: KernelToHostMessage) => void,
		generation: number,
	): Promise<EvalKernel> {
		await assertSessionCwdAvailable(this.#options.cwd);
		// py/rb/jl instances can die; the session holds one replaceable kernel per language so every
		// cell that kept a reference to it survives the death (JS heals its own worker).
		let memory: RegisteredKernelSource | undefined;
		const kernel =
			language === "js"
				? (() => {
						return this.#createKernel(language, onMessage).then((created) => {
							memory = created.memory;
							return created.kernel;
						});
					})()
				: ReplaceableKernel.create(language, async (lifecycle) => {
						const created = await this.#createKernel(language, onMessage, lifecycle);
						memory ??= created.memory;
						return created.kernel;
					});
		const resolvedKernel = await kernel;
		if (generation !== this.#generation) {
			await resolvedKernel.close();
			throw new CodemodeSessionDisposedError();
		}
		this.#kernels.set(language, resolvedKernel);
		this.#registrations.set(
			language,
			registerKernel(
				this.#options.ownerSessionId ?? this.#options.sessionId,
				language,
				memory as RegisteredKernelSource,
			),
		);
		// The directory can vanish while the interpreter starts; every caller sharing this creation
		// must see that, not only the next one. The kernel stays stored and dispose still closes it.
		await assertSessionCwdAvailable(this.#options.cwd);
		// A dispose that started during the check above already owns this stored kernel.
		if (generation !== this.#generation) throw new CodemodeSessionDisposedError();
		return resolvedKernel;
	}

	async #createKernel(
		language: EvalLanguage,
		onMessage: (message: KernelToHostMessage) => void,
		lifecycle: KernelLifecycle = {},
	): Promise<StartedKernel> {
		const bridge = this.#bridge;
		if (!bridge) throw new Error("codemode bridge server is not running");
		const configuredPoolWidth = this.#options.settings.parallelPoolWidth;
		const parallelPoolWidth = Number.isFinite(configuredPoolWidth) ? Math.max(1, Math.trunc(configuredPoolWidth)) : 1;
		// localRoots must be computed BEFORE the js branch: the JS kernel resolves local://
		// from its worker init connection exactly like the subprocess kernels resolve it from
		// theirs. Computing it after the early return left js cells with no local root at all.
		const localRoots =
			this.#options.localRoots ??
			(this.#options.artifactsDir ? { local: join(this.#options.artifactsDir, "local") } : undefined);
		if (language === "js") {
			const kernel = new JavaScriptKernel({
				sessionId: this.#options.sessionId,
				cwd: this.#options.cwd,
				parallelPoolWidth,
				onMessage,
				hostToolNames: () => this.#options.listTools?.().map((tool) => tool.name) ?? [],
				foreignLanguageNames: () => this.#foreignKernelToolNames(),
				memory: resolveKernelMemoryThresholds(this.#options.settings.memory),
				collectOrphanedChildren,
				...(this.#options.sessionEnv ? { sessionEnv: this.#options.sessionEnv } : {}),
				...(localRoots ? { localRoots: { ...localRoots } } : {}),
				...(this.#options.artifactsDir ? { artifactsDir: this.#options.artifactsDir } : {}),
			});
			return { kernel, memory: javaScriptKernelMemory(kernel) };
		}
		const detected = this.#options.availability[language].detected;
		if (!detected.ok) throw new Error(`No ${language} interpreter is available`);
		const connection = {
			port: bridge.port,
			token: bridge.token,
			parallelPoolWidth,
			...(localRoots ? { localRoots: { ...localRoots } } : {}),
			...(this.#options.artifactsDir ? { artifactsDir: this.#options.artifactsDir } : {}),
		};
		const shared = {
			sessionId: this.#options.sessionId,
			cwd: this.#options.cwd,
			...(this.#options.sessionEnv ? { sessionEnv: this.#options.sessionEnv } : {}),
			connection,
			onMessage,
			...lifecycle,
		};
		const memory = resolveKernelMemoryThresholds(this.#options.settings.memory);
		return await startSubprocessKernel({ language, interpreterPath: detected.path, memory, shared });
	}

	#foreignKernelToolNames(): string[] {
		const names: string[] = [];
		for (const [language, kernel] of this.#kernels) {
			if (language === "js") continue;
			names.push(...(kernel.listKernelToolNames?.() ?? []));
		}
		return names;
	}

	#contextFor(signal: AbortSignal): ExtensionContext {
		const ctx = this.#context;
		if (!ctx) throw new CodemodeContextUnavailableError();
		return { ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, signal]) : signal };
	}
}
