import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { appendDebugLogEntry } from "../../../hidden-stdout-log.ts";
import { MOVED_BREADCRUMB_FILE, type MovedBreadcrumb, parseMovedBreadcrumb } from "./breadcrumb.ts";
import { DESKTOP_HOME_MARKER_FILE, parseDesktopHomeId } from "./home-marker.ts";
import { matchMovedPrefix, type PathPlatform } from "./path-match.ts";

export interface MovedPath {
	/** The directory holding the breadcrumb (the old data root). */
	readonly oldRoot: string;
	readonly movedTo: string;
	readonly mappedPath: string;
}

export const MAX_HOPS = 3;

const jsonByFile = new Map<string, { readonly stamp: string; readonly value: unknown }>();

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** One small JSON file, re-read only when its mtime or size changed; `undefined` when absent or unreadable. */
export function readJsonFileSync(file: string): unknown {
	let stamp: string;
	try {
		const stats = statSync(file);
		if (!stats.isFile()) return undefined;
		stamp = `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return undefined;
	}
	const cached = jsonByFile.get(file);
	if (cached?.stamp === stamp) return cached.value;
	let value: unknown;
	try {
		value = parseJson(readFileSync(file, "utf8"));
	} catch {
		value = undefined;
	}
	jsonByFile.set(file, { stamp, value });
	return value;
}

export async function readJsonFileAsync(file: string): Promise<unknown> {
	let stamp: string;
	try {
		const stats = await stat(file);
		if (!stats.isFile()) return undefined;
		stamp = `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return undefined;
	}
	const cached = jsonByFile.get(file);
	if (cached?.stamp === stamp) return cached.value;
	let value: unknown;
	try {
		value = parseJson(await readFile(file, "utf8"));
	} catch {
		value = undefined;
	}
	jsonByFile.set(file, { stamp, value });
	return value;
}

export const breadcrumbFile = (dir: string): string => join(dir, MOVED_BREADCRUMB_FILE);
export const homeMarkerFile = (movedTo: string): string => join(movedTo, DESKTOP_HOME_MARKER_FILE);

const reported = new Set<string>();
function ignoreBreadcrumb(file: string, reason: string): undefined {
	const key = `${file}\0${reason}`;
	if (!reported.has(key)) {
		reported.add(key);
		try {
			appendDebugLogEntry("moved-path-guard: ignoring a breadcrumb", `${file}: ${reason}`);
		} catch {
			// The debug log is diagnostics only; a full disk must not change the guard's answer.
		}
	}
	return undefined;
}

export function parsedBreadcrumb(dir: string, raw: unknown): MovedBreadcrumb | undefined {
	if (raw === undefined) return undefined;
	const parsed = parseMovedBreadcrumb(raw);
	return parsed.kind === "valid" ? parsed.breadcrumb : ignoreBreadcrumb(breadcrumbFile(dir), parsed.reason);
}

/**
 * A breadcrumb is bound to a real desktop home: `movedTo` lies outside the breadcrumb's folder and holds the
 * desktop's ownership marker with the breadcrumb's `homeId`. The marker is immutable and its `origin.from` names only
 * a home's first source, so a later hop cannot be checked against it; the binding is the homeId (plan section 2).
 */
export function trustedBreadcrumb(
	dir: string,
	breadcrumb: MovedBreadcrumb,
	canonicalMovedTo: string,
	markerRaw: unknown,
	platform: PathPlatform,
): MovedBreadcrumb | undefined {
	if (matchMovedPrefix(canonicalMovedTo, dir, [[]], platform))
		return ignoreBreadcrumb(breadcrumbFile(dir), "movedTo is the breadcrumb's own folder or inside it");
	if (parseDesktopHomeId(markerRaw) !== breadcrumb.homeId)
		return ignoreBreadcrumb(breadcrumbFile(dir), "movedTo holds no desktop home marker with this homeId");
	return breadcrumb;
}

/** The listed prefix `canonical` lies under, with its mapped path; the caller still checks the prefix is not live again. */
export function movedMatch(
	dir: string,
	breadcrumb: MovedBreadcrumb,
	canonical: string,
	platform: PathPlatform,
): { readonly prefix: readonly string[]; readonly moved: MovedPath } | undefined {
	const match = matchMovedPrefix(canonical, dir, breadcrumb.moved, platform);
	if (!match) return undefined;
	return {
		prefix: match.prefix,
		moved: { oldRoot: dir, movedTo: breadcrumb.movedTo, mappedPath: join(breadcrumb.movedTo, ...match.remainder) },
	};
}

/** A worktree prefix that holds its own `.git` again belongs to whoever re-created it (a later T3 Code worktree). */
export const gitEntryOf = (oldRoot: string, prefix: readonly string[]): string | undefined =>
	prefix.includes("worktrees") ? join(oldRoot, ...prefix, ".git") : undefined;

export function movedPathReason(moved: MovedPath): string {
	return `This folder moved to ${moved.movedTo}. Use ${moved.mappedPath}.`;
}
