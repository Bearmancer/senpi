/**
 * The lifecycle supervisor's static import graph must stay small.
 *
 * A supervisor runs once per endpoint (every omo task shard and Desktop thread host), owns only the
 * public socket and restarts its host, and never parses CLI arguments or talks to a provider. Its
 * graph once reached `cli/args.js` - and through it the `@earendil-works/pi-ai` barrel and the whole
 * provider catalog - via one environment-name constant in `protocol-identity.ts`, which kept tens of
 * MB resident in every supervisor. The probe is Node's own loader hook, so a reintroduced edge,
 * direct or transitive, reappears here under any specifier.
 */
import { describe, expect, it } from "vitest";
import { probeImportGraph } from "./helpers/esm-import-graph-probe.ts";
import { assertWorkspaceBuildPrerequisite } from "./support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const repoRoot = new URL("../../..", import.meta.url).pathname;

const SUPERVISOR_FORBIDDEN = [
	{ what: "the CLI argument parser", reached: (url: string) => /\/dist\/cli\/args\.js$/u.test(url) },
	{ what: "the pi-ai provider barrel", reached: (url: string) => /\/ai\/dist\/index\.js$/u.test(url) },
] as const;

describe("RPC host supervisor import graph", () => {
	it("keeps the CLI argument parser and the provider catalog out of the supervisor", () => {
		const result = probeImportGraph(repoRoot, `${repoRoot}/packages/coding-agent/dist/modes/rpc/host-lifecycle.js`);

		// Guards the probe itself: an empty walk would make every absence below vacuous.
		expect(result.entries.some((entry) => /\/dist\/modes\/rpc\/socket-transport\.js$/u.test(entry.url))).toBe(true);

		for (const { what, reached } of SUPERVISOR_FORBIDDEN) {
			expect
				.soft(
					result.entries.filter((entry) => reached(entry.url)).map((entry) => entry.url),
					`the supervisor graph statically reaches ${what}`,
				)
				.toEqual([]);
		}
	});
});
