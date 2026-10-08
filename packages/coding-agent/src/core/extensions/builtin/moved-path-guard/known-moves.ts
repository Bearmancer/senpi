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

const reusedDecisions = new Map<string, boolean>();

/** The last answer this process got to "does this listed prefix hold its own `.git`", by `prefixKey`. */
export function rememberReused(key: string, reused: boolean): void {
	reusedDecisions.set(key, reused);
}

export function rememberedReused(key: string): boolean | undefined {
	return reusedDecisions.get(key);
}

/**
 * Remembers a trusted breadcrumb under its old root as the walk spelled it (realpath'd), and re-spelled under every
 * spelling of the user's home (`homes`: as `os.homedir()` spells it and its realpath) the root lies under. Commands
 * name `~/.t3/...` in the `$HOME` spelling, so on a host whose `$HOME` is a symlink the text fallback and the probe
 * ranking would otherwise never match it (fifth review M-2). The spellings come from the walk's own `home` step, so the
 * text checks stay free of filesystem work.
 */
export function rememberTrustedBreadcrumb(
	oldRoot: string,
	breadcrumb: MovedBreadcrumb,
	homes: readonly string[],
	platform: PathPlatform,
): void {
	const spellings = new Set([oldRoot]);
	for (const home of homes) {
		const under = matchMovedPrefix(oldRoot, home, [[]], platform);
		if (under) for (const other of homes) spellings.add(join(other, ...under.remainder));
	}
	for (const spelling of spellings) known.set(spelling, breadcrumb);
}

export function looksMoved(path: string, platform: PathPlatform = currentPathPlatform()): boolean {
	return (
		legacyRoots().some((root) => matchMovedPrefix(path, root, [[]], platform)) ||
		[...known].some(([oldRoot, breadcrumb]) => matchMovedPrefix(path, oldRoot, breadcrumb.moved, platform))
	);
}

/**
 * The moved location of `path` by text alone, from breadcrumbs trusted earlier in this process (senpi#2898 re-review
 * M3): used only for paths past a call's probe budget or deadline, so it does no filesystem work. A prefix this
 * process last found re-used (its own `.git`) is skipped, as the caller skips prefixes its own probe found re-used, so
 * a re-used worktree is never refused this way, also when a breadcrumb read timed out before the `.git` step
 * (fifth review M-1).
 */
export function knownMove(path: string, platform: PathPlatform = currentPathPlatform()): MovedPath | undefined {
	for (const [oldRoot, breadcrumb] of known) {
		const match = matchMovedPrefix(path, oldRoot, breadcrumb.moved, platform);
		if (match && rememberedReused(prefixKey(oldRoot, breadcrumb, match.prefix)) !== true)
			return { oldRoot, movedTo: breadcrumb.movedTo, mappedPath: join(breadcrumb.movedTo, ...match.remainder) };
	}
	return undefined;
}
