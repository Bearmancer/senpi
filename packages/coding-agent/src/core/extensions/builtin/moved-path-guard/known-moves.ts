import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { MovedBreadcrumb } from "./breadcrumb.ts";
import type { MovedPath } from "./breadcrumb-trust.ts";
import { currentPathPlatform, matchMovedPrefix, type PathPlatform } from "./path-match.ts";

/** The OmO desktop's legacy data roots (omo-desktop-app#1829), checked before any other path a call names. */
export const legacyRoots = (): string[] => [join(homedir(), ".t3"), join(homedir(), ".omo-app")];

const known = new Map<string, MovedBreadcrumb>();

/**
 * One (old root, listed prefix) of a trusted breadcrumb, keyed by what the breadcrumb says rather than by how the old
 * root was spelled, so a symlinked or `/var` vs `/private/var` spelling of one root shares one decision.
 */
export const prefixKey = (oldRoot: string, breadcrumb: MovedBreadcrumb, prefix: readonly string[]): string =>
	[basename(oldRoot).toLowerCase(), breadcrumb.homeId, breadcrumb.movedTo, prefix.join("/")].join("\0");

/** The (old root, listed prefix) keys a path lies under, by text, among breadcrumbs trusted so far. */
export function knownPrefixKeys(path: string, platform: PathPlatform = currentPathPlatform()): string[] {
	return [...known].flatMap(([oldRoot, breadcrumb]) => {
		const match = matchMovedPrefix(path, oldRoot, breadcrumb.moved, platform);
		return match ? [prefixKey(oldRoot, breadcrumb, match.prefix)] : [];
	});
}

export function rememberTrustedBreadcrumb(oldRoot: string, breadcrumb: MovedBreadcrumb): void {
	known.set(oldRoot, breadcrumb);
}

export function looksMoved(path: string, platform: PathPlatform = currentPathPlatform()): boolean {
	return (
		legacyRoots().some((root) => matchMovedPrefix(path, root, [[]], platform)) ||
		[...known].some(([oldRoot, breadcrumb]) => matchMovedPrefix(path, oldRoot, breadcrumb.moved, platform))
	);
}

/**
 * The moved location of `path` by text alone, from breadcrumbs trusted earlier in this process (senpi#2898 re-review
 * M3): used only for paths past a call's probe budget or deadline, so it does no filesystem work. The caller skips
 * prefixes its probe found re-used (their own `.git`), so a re-used worktree is never refused this way.
 */
export function knownMove(path: string, platform: PathPlatform = currentPathPlatform()): MovedPath | undefined {
	for (const [oldRoot, breadcrumb] of known) {
		const match = matchMovedPrefix(path, oldRoot, breadcrumb.moved, platform);
		if (match)
			return { oldRoot, movedTo: breadcrumb.movedTo, mappedPath: join(breadcrumb.movedTo, ...match.remainder) };
	}
	return undefined;
}
