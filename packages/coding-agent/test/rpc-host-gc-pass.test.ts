/**
 * The budgeted gc pass on its own (no host): its rate limit, its fair rotation past an uncollectable
 * head, and its skip backoff. Passes are separated by moving the marker's `completedAt` back past the
 * 5 min interval, so the real clock keeps driving the time budget and each skip's `skipUntil`.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHostEnsureLock } from "../src/modes/rpc/host-ensure-lock.ts";
import { gcHostEndpointsOpportunistically } from "../src/modes/rpc/host-gc-pass.ts";
import {
	GC_SKIP_INITIAL_BACKOFF_MS,
	type HostGcPassMarker,
	writeHostGcPassMarker,
} from "../src/modes/rpc/host-gc-pass-marker.ts";
import { deadEndpoint, listeningSocket } from "./helpers/rpc-host-gc-fixtures.ts";
import { readGcMarker } from "./helpers/rpc-host-gc-pass-fixtures.ts";

const roots: string[] = [];
const releases: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const release of releases.splice(0)) await release();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function scratchAgentDir(): string {
	const root = mkdtempSync(join(tmpdir(), "sa-gcp-"));
	roots.push(root);
	return root;
}

async function deadEndpoints(agentDir: string, count: number) {
	const endpoints = [];
	for (let index = 0; index < count; index += 1) {
		const socket = join(agentDir, "d", `e${index}.sock`);
		endpoints.push({ ...(await deadEndpoint(socket, agentDir)), socket });
	}
	return endpoints.sort((left, right) => (basename(left.dir) < basename(right.dir) ? -1 : 1));
}

async function expireInterval(agentDir: string): Promise<HostGcPassMarker> {
	const marker = await readGcMarker(agentDir);
	await writeHostGcPassMarker(agentDir, { ...marker, completedAt: marker.completedAt - 301_000 });
	return marker;
}

describe.skipIf(process.platform === "win32")("budgeted host gc pass", () => {
	it("runs at most once per 5 min interval: a second pass inside it does no work", async () => {
		const agentDir = scratchAgentDir();
		const target = join(agentDir, "t.sock");
		const [first, second] = await deadEndpoints(agentDir, 2);
		if (first === undefined || second === undefined) throw new Error("fixture endpoints missing");

		const ran = await gcHostEndpointsOpportunistically({ agentDir, exclude: target });
		expect(ran.ran && ran.marker.removed).toBe(2);
		await deadEndpoint(first.socket, agentDir);

		expect(await gcHostEndpointsOpportunistically({ agentDir, exclude: target })).toEqual({ ran: false });
		expect(existsSync(first.dir)).toBe(true);
	}, 60_000);

	it("never judges the target endpoint, even when it is dead", async () => {
		const agentDir = scratchAgentDir();
		const [target] = await deadEndpoints(agentDir, 1);
		if (target === undefined) throw new Error("fixture endpoint missing");

		const ran = await gcHostEndpointsOpportunistically({ agentDir, exclude: target.socket });
		expect(ran.ran && ran.marker.examined).toBe(0);
		expect(existsSync(target.endpointFile)).toBe(true);
	}, 60_000);

	it("rotates past an uncollectable head: all 40 dead endpoints go in three passes, the head is examined once", async () => {
		const agentDir = scratchAgentDir();
		const target = join(agentDir, "t.sock");
		const endpoints = await deadEndpoints(agentDir, 41);
		const [head, ...dead] = endpoints;
		if (head === undefined) throw new Error("fixture endpoints missing");
		// The worst candidate: its lock is held (the 2 s wait) and its socket answers.
		releases.push(await acquireHostEnsureLock(head.socket, 2_000));
		const server = await listeningSocket(head.socket);
		releases.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));

		const first = await gcHostEndpointsOpportunistically({ agentDir, exclude: target });
		expect(first.ran && first.marker).toMatchObject({ cursor: basename(head.dir), examined: 1, removed: 0 });
		expect(first.ran && first.marker.skip[basename(head.dir)]?.backoffMs).toBe(GC_SKIP_INITIAL_BACKOFF_MS);

		const passes: HostGcPassMarker[] = [];
		for (let pass = 0; pass < 2; pass += 1) {
			await expireInterval(agentDir);
			const next = await gcHostEndpointsOpportunistically({ agentDir, exclude: target });
			if (!next.ran) throw new Error("an expired interval did not allow a pass");
			passes.push(next.marker);
		}

		expect(dead.filter((endpoint) => existsSync(endpoint.dir))).toEqual([]);
		expect(passes.map((marker) => marker.removed).reduce((sum, removed) => sum + removed, 0)).toBe(40);
		for (const marker of passes) expect(marker.examined).toBeLessThanOrEqual(32);
		// Examined a second time, the backoff would have doubled.
		expect((await readGcMarker(agentDir)).skip[basename(head.dir)]?.backoffMs).toBe(GC_SKIP_INITIAL_BACKOFF_MS);
		expect(existsSync(head.endpointFile)).toBe(true);
	}, 120_000);
});
