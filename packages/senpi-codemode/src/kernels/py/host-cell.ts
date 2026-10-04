import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import type { HostCellExecutor } from "../../tool/types.ts";

type HostCellOutcome = Awaited<ReturnType<HostCellExecutor>>;

import type { PendingRun, ResultMessage } from "./kernel-contract.ts";
import { failedPythonResult } from "./transport.ts";

export function runHostCell(
	pending: PendingRun,
	host: HostCellExecutor,
	io: { readonly emit: (message: KernelToHostMessage) => void; readonly settle: (result: ResultMessage) => void },
): void {
	const abort = new AbortController();
	pending.hostAbort = abort;
	const cellId = pending.input.cellId;
	let finished = false;
	// Output from an executor that was aborted, or after its outcome, belongs to no cell.
	const emit = (message: KernelToHostMessage): void => {
		if (!finished && !abort.signal.aborted) io.emit(message);
	};
	// Calling the executor inside a promise keeps a synchronous throw in this cell instead of failing the queue.
	const done = new Promise<HostCellOutcome>((resolve) => resolve(host({ signal: abort.signal, emit }))).then(
		(outcome): ResultMessage =>
			outcome.ok
				? {
						type: "result",
						cellId,
						ok: true,
						durationMs: 0,
						...(outcome.valueRepr === undefined ? {} : { valueRepr: outcome.valueRepr }),
					}
				: { type: "result", cellId, ok: false, error: outcome.error, durationMs: 0 },
		(error: unknown): ResultMessage =>
			failedPythonResult(cellId, error instanceof Error ? error.message : String(error)),
	);
	pending.hostDone = done;
	void done.then((result) => {
		finished = true;
		if (!abort.signal.aborted) io.settle(result);
	});
}
