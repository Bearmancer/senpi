import type { ExtensionAPI } from "../../types.ts";
import { cachedToolsToCatalogEntries, collectToolCatalog, mcpRegistrationIdentity } from "./catalog.ts";
import { collectServerCatalogForCache, writeMcpCachedServer } from "./catalog-cache.ts";
import type { ResolvedMcpConfig } from "./config-schema.ts";
import { mapMcpCatalogNames } from "./expose/register.ts";
import {
	buildMcpTombstoneDefinition,
	createMcpListChangeCoalescer,
	diffMcpToolNames,
	formatMcpListChangedDelta,
} from "./notifications.ts";
import type { McpConnectionEntry } from "./service-types.ts";
import { SharedMcpLease } from "./shared-lease.ts";
import type { McpAsyncErrorSink } from "./wrap.ts";

type McpToolRegistrar = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">;

/** Coalesce a server's tools-changed signals into one refresh. `connectOnly` is true when
 * every merged signal came from a connect rather than from a reported change. */
export function subscribeMcpToolsChanged(
	entry: McpConnectionEntry,
	refresh: (connectOnly: boolean) => Promise<void>,
	sink: McpAsyncErrorSink,
): () => void {
	let changeReported = false;
	const coalescer = createMcpListChangeCoalescer({
		onRefresh: () => {
			const connectOnly = !changeReported;
			changeReported = false;
			return refresh(connectOnly);
		},
		scope: `mcp.list_changed.${entry.name}`,
		sink,
	});
	const unsubscribe = entry.connection.onToolsChanged((event) => {
		if (event.cause !== "connect") changeReported = true;
		coalescer.notify();
	});
	return () => {
		unsubscribe();
		coalescer.dispose();
	};
}

/**
 * Re-list a server on a coalesced tools-changed signal and re-register: added
 * tools enter INACTIVE (registerToolsPreservingActiveSet keeps the active set),
 * and removed tools are tombstoned so a stale call fails cleanly. Every connect
 * raises the signal too; a connect-only refresh leaves an unchanged catalog
 * registered, so the catalog lands once per session (#2177).
 */
export async function refreshMcpToolsOnListChanged(
	entry: McpConnectionEntry,
	pi: McpToolRegistrar,
	config: ResolvedMcpConfig,
	registerDirectTools: (pi: McpToolRegistrar) => Promise<void>,
	connectOnly: boolean,
): Promise<void> {
	const server = config.servers[entry.name];
	if (server?.config === undefined || entry.connection.state !== "connected") return;
	// The startup connect that still owns registration registers its refreshed catalog itself.
	if (connectOnly && entry.startupCatalogClaim?.ownsRegistration() === true) return;
	const registeredCatalog = entry.cachedCatalog;
	if (entry.connection instanceof SharedMcpLease) {
		entry.cachedCatalog = await entry.connection.catalog();
	}
	const catalog = await collectToolCatalog(entry.name, entry.connection, server.config, {
		agentDir: entry.agentDir,
		outputGuard: config.settings.outputGuard,
	});
	const newNames = mapMcpCatalogNames(catalog).map(({ name }) => name);
	// Before the first refresh, the registered names are the catalog the startup pass registered.
	const knownNames =
		entry.knownToolNames ??
		(registeredCatalog === undefined
			? newNames
			: mapMcpCatalogNames(
					cachedToolsToCatalogEntries(
						entry.name,
						registeredCatalog,
						entry.connection,
						server.config.requestTimeoutMs,
						async () => {},
					),
				).map(({ name }) => name));
	const diff = diffMcpToolNames(knownNames, newNames);
	if (!connectOnly || mcpRegistrationIdentity(catalog, entry.cachedCatalog) !== entry.registeredIdentity) {
		// Registration reads entry.cachedCatalog. A shared lease refreshed it above; nothing else
		// refreshes a non-shared connection's catalog after its startup connect (#2188).
		if (!(entry.connection instanceof SharedMcpLease)) {
			entry.cachedCatalog = await collectServerCatalogForCache(entry.connection, server.config, entry.configHash);
			await writeMcpCachedServer(entry.agentDir, entry.name, entry.cachedCatalog);
		}
		// Tombstone removed tools BEFORE re-registration so the subsequent
		// setActiveTools (which excludes them) leaves the tombstones inactive.
		for (const removed of diff.removed) pi.registerTool(buildMcpTombstoneDefinition(removed, entry.name));
		await registerDirectTools(pi);
	}
	entry.knownToolNames = newNames;
	entry.lastListChangedDelta = formatMcpListChangedDelta(diff);
}
