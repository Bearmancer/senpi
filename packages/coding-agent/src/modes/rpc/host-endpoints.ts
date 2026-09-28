/**
 * WHICH endpoints one agent directory holds state for, read from disk alone.
 *
 * A client that runs many hosts under one agent directory (omo: one per parent session, the Desktop:
 * one per thread) cannot enumerate them from the socket side - an endpoint whose host exited serves
 * nothing. The daemon directory is the only record, and each endpoint names itself in it:
 * `endpoint.json` first (durable, survives every generation's release), then the boot `settings.json`,
 * then any generation's own `settings.json`. Every source is accepted only when its socket hashes to
 * the directory it was found in, so a copied or foreign directory never lends its name to another.
 *
 * A directory none of them names is still reported, with `socket: null`: the ensure lock is keyed by
 * a longer hash of the socket's transport address and cannot be rebuilt from the 16-hex name, so such
 * a directory can be shown but never addressed. Reading only (I3): nothing here writes or unlinks.
 */
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { HOST_DAEMON_LAYOUT, hostDaemonDirectoryPaths, socketNamesDirectory } from "./host-daemon-paths.ts";
import { parseJson, readFileOrUndefined } from "./host-daemon-state.ts";

export type HostEndpointIdentitySource = "endpoint" | "settings" | "generation-settings" | "unknown";

export interface HostEndpointEntry {
	/** The endpoint this directory serves, or `null` when nothing in it names one. */
	readonly socket: string | null;
	/** The endpoint's daemon directory, `<agentDir>/rpc-host-daemon/<16hex>`. */
	readonly dir: string;
	/** Which file supplied `socket`. */
	readonly identity: HostEndpointIdentitySource;
}

const ENDPOINT_DIRECTORY_NAME = /^[0-9a-f]{16}$/;

/** Every endpoint directory under `agentDir`, sorted by directory name; `[]` before layout 2. */
export async function listHostEndpoints(agentDir: string): Promise<readonly HostEndpointEntry[]> {
	const flatDir = join(agentDir, "rpc-host-daemon");
	const marker = parseJson(await readFileOrUndefined(join(flatDir, "layout.json")).catch(() => undefined));
	if (marker?.layout !== HOST_DAEMON_LAYOUT) return [];
	const entries = await readdir(flatDir, { withFileTypes: true }).catch(() => []);
	const dirs = entries
		.filter((entry) => entry.isDirectory() && ENDPOINT_DIRECTORY_NAME.test(entry.name))
		.map((entry) => join(flatDir, entry.name))
		.sort();
	const endpoints: HostEndpointEntry[] = [];
	for (const dir of dirs) endpoints.push(await identifyEndpoint(dir));
	return endpoints;
}

async function identifyEndpoint(dir: string): Promise<HostEndpointEntry> {
	const paths = hostDaemonDirectoryPaths(dir);
	const named = await socketNamedBy(paths.endpointFile, dir);
	if (named !== undefined) return { socket: named, dir, identity: "endpoint" };
	const booted = await socketNamedBy(paths.settingsFile, dir);
	if (booted !== undefined) return { socket: booted, dir, identity: "settings" };
	const generations = await readdir(paths.generationsDir).catch(() => [] as string[]);
	for (const instanceId of generations.sort()) {
		const recorded = await socketNamedBy(join(paths.generationsDir, instanceId, "settings.json"), dir);
		if (recorded !== undefined) return { socket: recorded, dir, identity: "generation-settings" };
	}
	return { socket: null, dir, identity: "unknown" };
}

async function socketNamedBy(file: string, dir: string): Promise<string | undefined> {
	const record = parseJson(await readFileOrUndefined(file).catch(() => undefined));
	const socket = record?.socket;
	if (typeof socket !== "string" || socket === "") return undefined;
	return socketNamesDirectory(socket, basename(dir)) ? socket : undefined;
}
