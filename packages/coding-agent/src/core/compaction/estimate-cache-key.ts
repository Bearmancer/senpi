import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * The reuse key for the per-message estimate caches: the message's JSON text. It differs whenever any
 * estimate-relevant field differs (strings of any length, numbers, booleans, shape), including the
 * resident store's in-place token/text swaps, and it is cheaper to build than the estimate it guards
 * (the base64 scan and the wire estimate's serialization are what the cache saves). Unserializable
 * messages get no key and are never cached.
 */
export function collectMessageEstimateFingerprint(message: AgentMessage): string | undefined {
	try {
		return JSON.stringify(message);
	} catch {
		return undefined;
	}
}

/** Equality for estimate cache keys; an absent key never matches. */
export function estimateFingerprintsEqual(left: string | undefined, right: string | undefined): boolean {
	return left !== undefined && left === right;
}
