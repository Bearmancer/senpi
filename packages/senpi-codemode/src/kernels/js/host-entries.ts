import type { HostCellExecutor } from "../../tool/types.ts";
import { runHostCell } from "../shared/host-cell.ts";
import type { ResultMessage } from "./kernel-contract.ts";

/** The host entries (installs) a JavaScript kernel is running: started per queue slot, stopped by interrupt and close. */
export class HostEntries<Run> {
	readonly #aborts = new Map<Run, AbortController>();
	readonly #done = new Map<Run, Promise<unknown>>();

	start(
		run: Run,
		cellId: string,
		host: HostCellExecutor,
		io: Parameters<typeof runHostCell>[2] & { readonly settle: (result: ResultMessage) => void },
	): void {
		const entry = runHostCell(cellId, host, {
			...io,
			settle: (result) => {
				this.#aborts.delete(run);
				io.settle(result);
			},
		});
		this.#aborts.set(run, entry.abort);
		this.#done.set(run, entry.done);
		void entry.done.finally(() => this.#done.delete(run));
	}

	/** Aborts `run`'s host entry; false when `run` is not one. */
	abort(run: Run, reason: string): boolean {
		const abort = this.#aborts.get(run);
		if (abort === undefined) return false;
		abort.abort(new Error(reason));
		return true;
	}

	/** Aborts every running entry and waits for them to stop, at most `ms`: a closed kernel leaves no install running. */
	async stopAll(reason: string, ms: number): Promise<void> {
		const running = [...this.#done.values()];
		for (const abort of this.#aborts.values()) abort.abort(new Error(reason));
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.allSettled(running),
			new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))),
		]);
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** A turn-time refusal (an unreadable `%load` file, a refused magic) settles in queue order as a failed host entry. */
export function refusedEntry(message: string): HostCellExecutor {
	return async () => ({ ok: false, error: { message } });
}
