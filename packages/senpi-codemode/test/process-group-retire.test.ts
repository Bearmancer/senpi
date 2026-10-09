import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// The worker imports this plain-JS module; .ts files may not import .js, so it is loaded by URL.
const processTreeUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "process-tree.js")).href;
type Retire = (groups: readonly number[], options: { readonly graceMs: number }) => Promise<void>;
let terminateProcessGroups: Retire = async () => {
	throw new Error("process-tree.js not loaded");
};

beforeAll(async () => {
	const loaded: unknown = await import(processTreeUrl);
	if (
		typeof loaded !== "object" ||
		loaded === null ||
		!("terminateProcessGroups" in loaded) ||
		typeof loaded.terminateProcessGroups !== "function"
	) {
		throw new Error("process-tree.js does not export terminateProcessGroups");
	}
	const retire = loaded.terminateProcessGroups;
	terminateProcessGroups = async (groups, options) => {
		await retire(groups, options);
	};
});

describe.skipIf(process.platform === "win32")("cell process-group retirement (senpi#3020)", () => {
	it("Given the agent's own process group in the list when groups are retired then the agent is not signalled", async () => {
		// given
		const signalled: number[] = [];
		const realKill = process.kill;
		process.kill = ((pid: number, signal?: string | number) => {
			if (signal !== 0 && signal !== undefined) signalled.push(pid);
			return realKill.call(process, pid, signal);
		}) as typeof process.kill;

		// when
		try {
			await terminateProcessGroups([process.pid, 1, 0, -5], { graceMs: 50 });
		} finally {
			process.kill = realKill;
		}

		// then
		expect(signalled).toEqual([]);
	});
});
