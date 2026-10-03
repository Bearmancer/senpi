import { createHash } from "node:crypto";
import type { ExtensionContext } from "@code-yeongyu/senpi";
import { CodemodeSessionDisposedError } from "./session-manager.ts";
import { CodemodeSessionNotStartedError } from "./session-manager-proxy.ts";

export class CodemodeRuntimeRecreationError extends Error {
	readonly name = "CodemodeRuntimeRecreationError";

	constructor(reason: string) {
		super(`codemode runtime could not be re-created: ${reason}. Start a new session or reload to bring eval back.`);
	}
}

type Execute<Args extends unknown[], Result> = (...args: Args) => Promise<Result>;

/**
 * A session_start whose runtime could not be created leaves the session running with no usable manager.
 * The next eval re-creates the runtime once and runs; one stderr line names the failed start (session id
 * hashed, nothing else) so a recurrence stays visible. A session that ended (session_shutdown) is never
 * recovered: post-shutdown work keeps failing.
 */
export class StartRecovery {
	#failedStart: { readonly event: unknown; readonly reason: string } | undefined;
	readonly #restart: (event: unknown, ctx: ExtensionContext) => Promise<void>;
	readonly #report: (line: string) => void;

	constructor(
		restart: (event: unknown, ctx: ExtensionContext) => Promise<void>,
		report: (line: string) => void = (line) => globalThis.process.stderr.write(`${line}\n`),
	) {
		this.#restart = restart;
		this.#report = report;
	}

	startFailed(event: unknown, error: unknown): void {
		this.#failedStart = { event, reason: error instanceof Error ? error.message : String(error) };
	}

	started(): void {
		this.#failedStart = undefined;
	}

	sessionEnded(): void {
		this.#failedStart = undefined;
	}

	wrap<Args extends unknown[], Result>(
		execute: Execute<Args, Result>,
		contextOf: (args: Args) => unknown,
	): Execute<Args, Result> {
		return async (...args) => {
			try {
				return await execute(...args);
			} catch (error) {
				const failed = this.#failedStart;
				const ctx = contextOf(args);
				const unusable =
					error instanceof CodemodeSessionDisposedError || error instanceof CodemodeSessionNotStartedError;
				if (!unusable || failed === undefined || !isContext(ctx)) throw error;
				this.#report(
					`[senpi-codemode] eval re-created a runtime left disposed by a failed session_start (session ${sessionHash(ctx)})`,
				);
				try {
					await this.#restart(failed.event, ctx);
				} catch (restartError) {
					throw new CodemodeRuntimeRecreationError(
						restartError instanceof Error ? restartError.message : String(restartError),
					);
				}
				return await execute(...args);
			}
		};
	}
}

function isContext(value: unknown): value is ExtensionContext {
	return typeof value === "object" && value !== null && "sessionManager" in value;
}

function sessionHash(ctx: ExtensionContext): string {
	const id = ctx.sessionManager.getSessionId?.() ?? "unknown";
	return createHash("sha256").update(id).digest("hex").slice(0, 12);
}
