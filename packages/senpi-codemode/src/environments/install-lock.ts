import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { link, mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const LOCK_FILE = ".install.lock";
const TAKEOVER_DIR = ".install.lock.takeover";
const RECHECK_MS = 500;
// An unparseable lock can only come from a crash in an older version's create-then-write; it is stale once old.
const UNREADABLE_STALE_MS = 5_000;
const TAKEOVER_STALE_MS = 30_000;
const WAIT_NOTICE_MS = 30_000;

type Holder = { readonly pid: number; readonly host: string; readonly nonce: string };

export type LockWaitNotice = {
	readonly holder: { readonly pid: number; readonly host: string } | undefined;
	readonly waitedMs: number;
};

/**
 * Serialises installs into one environment root across sessions and processes.
 *
 * The lock file is published complete (written to a unique temp file, then `link`ed into place, which fails
 * if a lock exists), so it is never seen empty. A lock whose holder is a dead process on this host, or
 * that is unreadable and old, is stale; it is removed only inside a takeover section guarded by an
 * exclusively created directory, after re-reading it there. Inside that section nobody else can remove
 * the lock, so the re-read and the remove can't race, and a live lock is never deleted.
 */
export async function withRootLock<T>(
	base: string,
	fn: () => Promise<T>,
	signal?: AbortSignal,
	onWait?: (notice: LockWaitNotice) => void,
): Promise<T> {
	const path = join(base, LOCK_FILE);
	const mine: Holder = { pid: process.pid, host: hostname(), nonce: randomUUID() };
	const started = Date.now();
	let noticed = false;
	for (;;) {
		signal?.throwIfAborted();
		if (await tryCreate(base, path, mine)) break;
		if (await takeOverIfStale(base, path)) continue;
		if (!noticed && Date.now() - started >= WAIT_NOTICE_MS) {
			noticed = true;
			const holder = await readHolder(path);
			onWait?.({ holder: holder && { pid: holder.pid, host: holder.host }, waitedMs: Date.now() - started });
		}
		await waitForRelease(base, path, signal);
	}
	try {
		return await fn();
	} finally {
		const holder = await readHolder(path);
		if (holder?.nonce === mine.nonce) await rm(path, { force: true });
	}
}

async function tryCreate(base: string, path: string, holder: Holder): Promise<boolean> {
	const temp = join(base, `.install.lock.${holder.nonce}`);
	await writeFile(temp, JSON.stringify(holder), { mode: 0o600 });
	try {
		await link(temp, path);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		await rm(temp, { force: true });
	}
}

async function takeOverIfStale(base: string, path: string): Promise<boolean> {
	if (!(await isStale(path))) return false;
	const takeover = join(base, TAKEOVER_DIR);
	if (!(await enterTakeover(takeover))) return false;
	try {
		if (!(await isStale(path))) return false;
		await rm(path, { force: true });
		return true;
	} finally {
		await rmdir(takeover).catch(() => undefined);
	}
}

async function enterTakeover(takeover: string): Promise<boolean> {
	try {
		await mkdir(takeover);
		return true;
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	const age = await ageMs(takeover);
	if (age !== undefined && age > TAKEOVER_STALE_MS) await rmdir(takeover).catch(() => undefined);
	return false;
}

async function isStale(path: string): Promise<boolean> {
	const holder = await readHolder(path);
	if (holder !== undefined) return holder.host === hostname() && !isAlive(holder.pid);
	const age = await ageMs(path);
	return age !== undefined && age > UNREADABLE_STALE_MS;
}

async function readHolder(path: string): Promise<Holder | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const pid = "pid" in value ? value.pid : undefined;
		const host = "host" in value ? value.host : undefined;
		const nonce = "nonce" in value ? value.nonce : undefined;
		return typeof pid === "number" && typeof host === "string"
			? { pid, host, nonce: typeof nonce === "string" ? nonce : "" }
			: undefined;
	} catch {
		return undefined;
	}
}

async function ageMs(path: string): Promise<number | undefined> {
	try {
		return Date.now() - (await stat(path)).mtimeMs;
	} catch {
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Wakes when the lock file goes away; the periodic recheck covers dropped file-watch events and staleness. */
function waitForRelease(base: string, path: string, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const watcher = watch(base, () => check());
		const timer = setInterval(() => check(), RECHECK_MS);
		const onAbort = () => done(() => reject(signal?.reason));
		signal?.addEventListener("abort", onAbort, { once: true });
		let settled = false;
		function done(settle: () => void): void {
			if (settled) return;
			settled = true;
			watcher.close();
			clearInterval(timer);
			signal?.removeEventListener("abort", onAbort);
			settle();
		}
		function check(): void {
			void stat(path).then(
				() => isStale(path).then((stale) => stale && done(resolve)),
				() => done(resolve),
			);
		}
		// The holder may have released between the failed create and the watcher starting; no event would follow.
		check();
	});
}
