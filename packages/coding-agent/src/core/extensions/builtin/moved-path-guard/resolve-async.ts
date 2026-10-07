import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { canonicalizeFilesystemPath } from "../../../tools/filesystem-policy.ts";
import type { MovedBreadcrumb } from "./breadcrumb.ts";
import {
	breadcrumbFile,
	gitEntryOf,
	homeMarkerFile,
	MAX_HOPS,
	type MovedPath,
	movedMatch,
	parsedBreadcrumb,
	readJsonFileAsync,
	trustedBreadcrumb,
} from "./breadcrumb-trust.ts";
import { currentPathPlatform, type PathPlatform } from "./path-match.ts";

export type MovedPathProbe = (path: string) => Promise<MovedPath | undefined>;

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readTrustedBreadcrumb(dir: string, platform: PathPlatform): Promise<MovedBreadcrumb | undefined> {
	const breadcrumb = parsedBreadcrumb(dir, await readJsonFileAsync(breadcrumbFile(dir)));
	if (!breadcrumb) return undefined;
	const [canonicalMovedTo, marker] = await Promise.all([
		canonicalizeFilesystemPath(breadcrumb.movedTo),
		readJsonFileAsync(homeMarkerFile(breadcrumb.movedTo)),
	]);
	return trustedBreadcrumb(dir, breadcrumb, canonicalMovedTo, marker, platform);
}

/**
 * Resolution for one tool call (senpi#2898): asynchronous and canonicalized through the bounded
 * `canonicalizeFilesystemPath`, so a wedged mount never blocks the session loop. The probe reads each ancestor's
 * breadcrumb once for the whole call; the caller bounds the call with a deadline.
 */
export function createMovedPathProbe(platform: PathPlatform = currentPathPlatform()): MovedPathProbe {
	const breadcrumbs = new Map<string, Promise<MovedBreadcrumb | undefined>>();
	const breadcrumbIn = (dir: string): Promise<MovedBreadcrumb | undefined> => {
		let read = breadcrumbs.get(dir);
		if (!read) {
			read = readTrustedBreadcrumb(dir, platform);
			breadcrumbs.set(dir, read);
		}
		return read;
	};
	const movedOnce = async (path: string): Promise<MovedPath | undefined> => {
		const canonical = await canonicalizeFilesystemPath(path);
		const stop = dirname(homedir());
		for (let dir = dirname(canonical); ; dir = dirname(dir)) {
			const breadcrumb = await breadcrumbIn(dir);
			const match = breadcrumb && movedMatch(dir, breadcrumb, canonical, platform);
			const gitEntry = match && gitEntryOf(dir, match.prefix);
			if (match && !(gitEntry && (await pathExists(gitEntry)))) return match.moved;
			if (dir === stop || dirname(dir) === dir) return undefined;
		}
	};
	return async (path) => {
		let found: MovedPath | undefined;
		for (let hop = 0; hop < MAX_HOPS; hop++) {
			const next = await movedOnce(found?.mappedPath ?? path);
			if (!next) break;
			found = found ? { ...next, oldRoot: found.oldRoot } : next;
		}
		return found;
	};
}
