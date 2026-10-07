import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { MOVED_BREADCRUMB_FILE, type MovedBreadcrumb, parseMovedBreadcrumb } from "./breadcrumb.ts";
import { currentPathPlatform, matchMovedPrefix, type PathPlatform } from "./path-match.ts";

export interface MovedPath {
	/** The directory holding the breadcrumb (the old data root). */
	readonly oldRoot: string;
	readonly movedTo: string;
	readonly mappedPath: string;
}

const MAX_HOPS = 3;
const parsedByFile = new Map<string, { readonly stamp: string; readonly breadcrumb: MovedBreadcrumb | undefined }>();

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

function readBreadcrumb(dir: string): MovedBreadcrumb | undefined {
	const file = join(dir, MOVED_BREADCRUMB_FILE);
	let stamp: string;
	try {
		const stats = statSync(file);
		if (!stats.isFile()) return undefined;
		stamp = `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return undefined;
	}
	const cached = parsedByFile.get(file);
	if (cached?.stamp === stamp) return cached.breadcrumb;
	let breadcrumb: MovedBreadcrumb | undefined;
	try {
		const parsed = parseMovedBreadcrumb(JSON.parse(readFileSync(file, "utf8")));
		if (parsed.kind === "valid") breadcrumb = parsed.breadcrumb;
		else console.warn(`moved-path-guard: ignoring ${file}: ${parsed.reason}`);
	} catch (error) {
		console.warn(`moved-path-guard: ignoring ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	parsedByFile.set(file, { stamp, breadcrumb });
	return breadcrumb;
}

/** A worktree prefix that holds its own `.git` again belongs to whoever re-created it (a later T3 Code worktree). */
function liveAgain(oldRoot: string, prefix: readonly string[]): boolean {
	return prefix.includes("worktrees") && existsSync(join(oldRoot, ...prefix, ".git"));
}

function movedOnce(path: string, platform: PathPlatform): MovedPath | undefined {
	const canonical = canonicalPath(path);
	const stop = dirname(homedir());
	for (let dir = dirname(canonical); ; dir = dirname(dir)) {
		const breadcrumb = readBreadcrumb(dir);
		if (breadcrumb) {
			const match = matchMovedPrefix(canonical, dir, breadcrumb.moved, platform);
			if (match && !liveAgain(dir, match.prefix))
				return {
					oldRoot: dir,
					movedTo: breadcrumb.movedTo,
					mappedPath: join(breadcrumb.movedTo, ...match.remainder),
				};
		}
		if (dir === stop || dirname(dir) === dir) return undefined;
	}
}

/**
 * Where an absolute path the OmO desktop moved lives now (senpi#2898), following up to three moves, or
 * undefined when no breadcrumb above it lists it. Discovery reads the filesystem on every call, so a
 * breadcrumb written after the process started is seen at once; only parsed breadcrumbs are memoized.
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

export function movedPathReason(moved: MovedPath): string {
	return `This folder moved to ${moved.movedTo}. Use ${moved.mappedPath}.`;
}
