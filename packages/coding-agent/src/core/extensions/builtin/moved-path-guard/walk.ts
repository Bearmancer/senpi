import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { MovedBreadcrumb } from "./breadcrumb.ts";
import {
	breadcrumbFile,
	gitEntryOf,
	homeMarkerFile,
	MAX_HOPS,
	type MovedPath,
	movedMatch,
	movedToInHome,
	parsedBreadcrumb,
	trustedBreadcrumb,
	trustedFolder,
} from "./breadcrumb-trust.ts";
import { prefixKey, rememberedReused, rememberReused, rememberTrustedBreadcrumb } from "./known-moves.ts";
import { type PathPlatform, sameSegment } from "./path-match.ts";

/** One filesystem question the walk asks; the sync and async resolvers answer it with their own I/O. */
export type ResolverStep =
	| { readonly op: "canonical"; readonly path: string }
	| { readonly op: "json"; readonly file: string }
	| { readonly op: "exists"; readonly path: string }
	| { readonly op: "folder"; readonly path: string }
	| { readonly op: "home" };

/**
 * The answer to a step whose I/O failed or timed out. A path whose own canonicalization fails is walked by its
 * spelling instead, so a moved prefix is still recognized through its breadcrumb and an unrelated path still is not.
 */
export function failedReply(_step: ResolverStep): unknown {
	return undefined;
}

/** The user's home as `os.homedir()` spells it, plus its realpath when a resolver could answer the `home` step. */
function* homeSpellings(): Walk<string[]> {
	const home = homedir();
	const real = (yield { op: "home" }) as string | undefined;
	return real !== undefined && real !== home ? [home, real] : [home];
}

type Walk<T> = Generator<ResolverStep, T, unknown>;

/**
 * The old root `dir` as the walk's caller spelled it: `path` without the segments `canonical` has below `dir`, when
 * `path` ends in the same segments (a symlink above the old root, such as `~/.t3` or `$HOME`, changes only what lies
 * above them). `undefined` when they differ, as when a symlink sits below the old root.
 */
function calledSpelling(path: string, canonical: string, dir: string, platform: PathPlatform): string | undefined {
	let called = resolve(path);
	for (let below = canonical; below !== dir; below = dirname(below)) {
		if (dirname(called) === called || !sameSegment(basename(called), basename(below), platform)) return undefined;
		called = dirname(called);
	}
	return called;
}

type OnReused = (oldRoot: string, breadcrumb: MovedBreadcrumb, prefix: readonly string[]) => void;

function* movedOnce(path: string, platform: PathPlatform, onReused?: OnReused): Walk<MovedPath | undefined> {
	const canonical = ((yield { op: "canonical", path }) as string | undefined) ?? resolve(path);
	const stop = dirname(homedir());
	for (let dir = dirname(canonical); ; dir = dirname(dir)) {
		const breadcrumb = parsedBreadcrumb(dir, yield { op: "json", file: breadcrumbFile(dir) });
		// The listed-prefix match comes first: a breadcrumb that lists nothing this path is under never makes the
		// walk touch the folder it names.
		const match = breadcrumb && movedMatch(dir, breadcrumb, canonical, platform);
		const homes = match ? yield* homeSpellings() : [];
		if (
			match &&
			movedToInHome(dir, breadcrumb, homes, platform) &&
			trustedFolder(dir, (yield { op: "folder", path: dir }) as Stats | undefined) &&
			trustedBreadcrumb(dir, breadcrumb, yield { op: "json", file: homeMarkerFile(breadcrumb.movedTo) }, platform)
		) {
			// The re-used decision is recorded before the breadcrumb is remembered, so no text fallback in this call can
			// refuse a prefix the walk just found live again.
			const gitEntry = gitEntryOf(dir, match.prefix);
			let reused = false;
			if (gitEntry !== undefined) {
				const key = prefixKey(dir, breadcrumb, match.prefix);
				const answer = yield { op: "exists", path: gitEntry };
				// A .git check that cannot answer keeps this process's last answer for the prefix; with none, the prefix is
				// treated as the text fallback treats it: not re-used. Accepted (sixth review LOW-2): a remembered "re-used"
				// does not expire by itself. If that worktree's .git is removed and the next calls' breadcrumb steps time out
				// before any probe of the prefix answers, those calls still allow it; the first call whose walk reaches the
				// .git check corrects the answer. Any other default would refuse a live worktree again (fifth review M-1).
				if (typeof answer === "boolean") rememberReused(key, answer);
				reused = typeof answer === "boolean" ? answer : (rememberedReused(key) ?? false);
			}
			if (reused) onReused?.(dir, breadcrumb, match.prefix);
			rememberTrustedBreadcrumb(dir, calledSpelling(path, canonical, dir, platform), breadcrumb, homes, platform);
			if (!reused) return match.moved;
		}
		if (dir === stop || dirname(dir) === dir) return undefined;
	}
}

/**
 * The single decision both resolvers drive (senpi#2898): canonicalize the path, walk its ancestors for a breadcrumb
 * listing it, trust that breadcrumb only when its home's marker matches, and follow up to `MAX_HOPS` moves. Every I/O
 * is a yielded step, so the sync and async resolvers cannot disagree on order or on what a failure means.
 */
export function* movedPathWalk(path: string, platform: PathPlatform, onReused?: OnReused): Walk<MovedPath | undefined> {
	let found: MovedPath | undefined;
	for (let hop = 0; hop < MAX_HOPS; hop++) {
		const next = yield* movedOnce(found?.mappedPath ?? path, platform, onReused);
		if (!next) break;
		found = found ? { ...next, oldRoot: found.oldRoot } : next;
	}
	return found;
}
