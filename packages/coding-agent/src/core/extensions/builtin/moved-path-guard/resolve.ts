import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type MovedPath, readJsonFileSync } from "./breadcrumb-trust.ts";
import { currentPathPlatform, type PathPlatform } from "./path-match.ts";
import { failedReply, movedPathWalk, type ResolverStep } from "./walk.ts";

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
	return join(realpathSync(existing), ...missing);
}

function answer(step: ResolverStep): unknown {
	try {
		if (step.op === "canonical") return canonicalPath(step.path);
		if (step.op === "json") return readJsonFileSync(step.file);
		if (step.op === "home") return realpathSync(homedir());
		if (step.op === "folder") return lstatSync(step.path);
		return existsSync(step.path);
	} catch {
		return failedReply(step);
	}
}

/**
 * Synchronous resolution, only for callers that are synchronous themselves and hold one session path: the registry
 * open, session-holder claims and schedule delivery (senpi#2898). Tool calls use `createMovedPathProbe`, which never
 * blocks the session loop. Both drive the same walk (`walk.ts`).
 *
 * Bound, per hop (at most `MAX_HOPS`): canonicalizing the one path; one O_NOFOLLOW open of at most 64 KiB per
 * ancestor directory's breadcrumb; and, only for a breadcrumb listing this path whose `movedTo` lies under the user's
 * home, one `lstat` of the breadcrumb's folder, one such open of that home's marker and one `.git` existence check.
 */
export function findMovedPath(path: string, platform: PathPlatform = currentPathPlatform()): MovedPath | undefined {
	const walk = movedPathWalk(path, platform);
	let step = walk.next();
	while (!step.done) step = walk.next(answer(step.value));
	return step.value;
}

export function resolveMovedPath(path: string): string {
	return findMovedPath(path)?.mappedPath ?? path;
}
