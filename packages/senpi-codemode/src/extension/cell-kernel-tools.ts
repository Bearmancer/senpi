import { kernelToolsStorage } from "@code-yeongyu/senpi";
import type { KernelToolsCapability } from "../kernels/js/kernel-tools-types.ts";

/**
 * Kernel-tools capabilities of the cells running right now, keyed by cell id. Subprocess kernels (py/rb/jl) reach the
 * host over the bridge, outside the submitting cell's async context, so a bridge call names its cell and runs inside
 * that cell's capability: the same `kernelToolsStorage` scope the JS worker path enters per host call (#1754).
 */
export class CellKernelTools {
	readonly #byCell = new Map<string, KernelToolsCapability>();

	/** Makes `capability` the kernel tools of calls naming `cellId` until the returned release runs. */
	bind(cellId: string, capability: KernelToolsCapability): () => void {
		this.#byCell.set(cellId, capability);
		return () => {
			if (this.#byCell.get(cellId) === capability) this.#byCell.delete(cellId);
		};
	}

	/** Runs `call` with the named cell's capability; an absent, unknown or finished cell gets none. */
	async run<T>(cellId: string | undefined, call: () => Promise<T>): Promise<T> {
		const capability = cellId === undefined ? undefined : this.#byCell.get(cellId);
		return capability === undefined
			? await kernelToolsStorage.exit(call)
			: await kernelToolsStorage.run(capability, call);
	}
}
