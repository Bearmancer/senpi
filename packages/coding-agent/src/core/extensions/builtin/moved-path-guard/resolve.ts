import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { MovedBreadcrumb } from "./breadcrumb.ts";
import {
	breadcrumbFile,
	gitEntryOf,
	homeMarkerFile,
	MAX_HOPS,
	type MovedPath,
	movedMatch,
	parsedBreadcrumb,
	readJsonFileSync,
	trustedBreadcrumb,
} from "./breadcrumb-trust.ts";
import { currentPathPlatform, type PathPlatform } from "./path-match.ts";

export { type MovedPath, movedPathReason } from "./breadcrumb-trust.ts";

/** Realpath of the deepest existing ancestor plus the missing tail, so every spelling of a path compares equal. */
function canonicalPath(path: string): string {
	const missing: string[] = [];
	let existing = resolve(path);
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return resolve(path);
		missing.unshift(basename(existing));
		existing = parent;
	}
	try {
		return join(realpathSync(existing), ...missing);
	} catch {
		return resolve(path);
	}
}

function readTrustedBreadcrumb(dir: string, platform: PathPlatform): MovedBreadcrumb | undefined {
	const breadcrumb = parsedBreadcrumb(dir, readJsonFileSync(breadcrumbFile(dir)));
	if (!breadcrumb) return undefined;
	const marker = readJsonFileSync(homeMarkerFile(breadcrumb.movedTo));
	return trustedBreadcrumb(dir, breadcrumb, canonicalPath(breadcrumb.movedTo), marker, platform);
}

function movedOnce(path: string, platform: PathPlatform): MovedPath | undefined {
	const canonical = canonicalPath(path);
	const stop = dirname(homedir());
	for (let dir = dirname(canonical); ; dir = dirname(dir)) {
		const breadcrumb = readTrustedBreadcrumb(dir, platform);
		const match = breadcrumb && movedMatch(dir, breadcrumb, canonical, platform);
		const gitEntry = match && gitEntryOf(dir, match.prefix);
		if (match && !(gitEntry && existsSync(gitEntry))) return match.moved;
		if (dir === stop || dirname(dir) === dir) return undefined;
	}
}

/**
 * Synchronous resolution, only for callers that are synchronous themselves and hold one session path: the registry
 * open, session-holder claims and schedule delivery (senpi#2898). Tool calls use `createMovedPathProbe`, which never
 * blocks the session loop. Discovery reads the filesystem on every call; only parsed files are memoized.
 */
export function findMovedPath(path: string, platform: PathPlatform = currentPathPlatform()): MovedPath | undefined {
	let found: MovedPath | undefined;
	for (let hop = 0; hop < MAX_HOPS; hop++) {
		const next = movedOnce(found?.mappedPath ?? path, platform);
		if (!next) break;
		found = found ? { ...next, oldRoot: found.oldRoot } : next;
	}
	return found;
}

export function resolveMovedPath(path: string): string {
	return findMovedPath(path)?.mappedPath ?? path;
}
