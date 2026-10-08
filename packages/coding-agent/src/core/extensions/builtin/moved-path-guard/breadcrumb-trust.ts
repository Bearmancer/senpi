import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { MOVED_BREADCRUMB_FILE, type MovedBreadcrumb, parseMovedBreadcrumb } from "./breadcrumb.ts";
import { logGuardEvent } from "./guard-log.ts";
import { DESKTOP_HOME_MARKER_FILE, parseDesktopHomeMarker } from "./home-marker.ts";
import { matchMovedPrefix, type PathPlatform } from "./path-match.ts";

export interface MovedPath {
	/** The directory holding the breadcrumb (the old data root). */
	readonly oldRoot: string;
	readonly movedTo: string;
	readonly mappedPath: string;
}

export const MAX_HOPS = 3;

/** A breadcrumb or marker is a few hundred bytes; anything larger is not one and is never read. */
export const MAX_TRUST_FILE_BYTES = 64 * 1024;

const jsonByFile = new Map<string, { readonly stamp: string; readonly value: unknown }>();

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Whether a breadcrumb or marker may be believed, from `fstat` of the descriptor it is read through (opened without
 * following a symlink, so the decision and the content are the same file): a regular file of at most
 * `MAX_TRUST_FILE_BYTES`, and on POSIX owned by this user and writable by nobody else, so another local user cannot
 * plant one in a shared folder such as `/tmp` (senpi#2898). Windows has no uid/mode to check; there the marker's
 * homeId binding is the only guard.
 */
function trustStamp(stats: Stats): string | undefined {
	if (!stats.isFile() || stats.size > MAX_TRUST_FILE_BYTES) return undefined;
	if (process.platform !== "win32" && (stats.uid !== process.getuid?.() || (stats.mode & 0o022) !== 0))
		return undefined;
	return `${stats.mtimeMs}:${stats.size}:${stats.ino}`;
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function remembered(file: string, stamp: string, read: () => Buffer): unknown {
	const cached = jsonByFile.get(file);
	if (cached?.stamp === stamp) return cached.value;
	const value = parseJson(read().toString("utf8"));
	jsonByFile.set(file, { stamp, value });
	return value;
}

/** One small JSON file the guard may trust, re-read only when it changed; `undefined` when absent, unreadable or untrusted. */
export function readJsonFileSync(file: string): unknown {
	let fd: number;
	try {
		fd = openSync(file, OPEN_FLAGS);
	} catch {
		return undefined;
	}
	try {
		const stats = fstatSync(fd);
		const stamp = trustStamp(stats);
		if (stamp === undefined) return undefined;
		return remembered(file, stamp, () => {
			const buffer = Buffer.alloc(stats.size);
			return buffer.subarray(0, readSync(fd, buffer, 0, stats.size, 0));
		});
	} finally {
		closeSync(fd);
	}
}

export async function readJsonFileAsync(file: string): Promise<unknown> {
	const handle = await open(file, OPEN_FLAGS).catch(() => undefined);
	if (!handle) return undefined;
	try {
		const stats = await handle.stat();
		const stamp = trustStamp(stats);
		if (stamp === undefined) return undefined;
		const cached = jsonByFile.get(file);
		if (cached?.stamp === stamp) return cached.value;
		const buffer = Buffer.alloc(stats.size);
		const { bytesRead } = await handle.read(buffer, 0, stats.size, 0);
		return remembered(file, stamp, () => buffer.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}
}

export const breadcrumbFile = (dir: string): string => join(dir, MOVED_BREADCRUMB_FILE);
export const homeMarkerFile = (movedTo: string): string => join(movedTo, DESKTOP_HOME_MARKER_FILE);

function ignoreBreadcrumb(file: string, reason: string): undefined {
	logGuardEvent("debug", "breadcrumb_ignored", { file, reason });
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
	markerRaw: unknown,
	platform: PathPlatform,
): MovedBreadcrumb | undefined {
	if (matchMovedPrefix(breadcrumb.movedTo, dir, [[]], platform))
		return ignoreBreadcrumb(breadcrumbFile(dir), "movedTo is the breadcrumb's own folder or inside it");
	const marker = parseDesktopHomeMarker(markerRaw);
	if (marker.kind === "newer") {
		logGuardEvent("warn", "marker_newer", {
			file: homeMarkerFile(breadcrumb.movedTo),
			schemaVersion: String(marker.schemaVersion),
		});
		return undefined;
	}
	if (marker.kind !== "valid" || marker.homeId !== breadcrumb.homeId)
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
