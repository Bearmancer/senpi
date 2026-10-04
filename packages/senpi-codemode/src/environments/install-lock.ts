import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const LOCK_FILE = ".install.lock";
const TAKEOVER_FILE = ".install.lock.takeover";
const RECHECK_MS = 500;
// An unparseable lock can only come from a crash in an older version's create-then-write; it is stale once old.
const UNREADABLE_STALE_MS = 5_000;
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
 * that is unreadable and old, is stale. It is removed only by a waiter holding the takeover token (a second
 * file published the same way, itself stale once its holder dies), and only if it is still byte-for-byte
 * the lock judged stale: it is renamed aside and compared first, and anything else is put back. A live
 * lock is never deleted, even if two waiters somehow both hold the takeover.
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
	const stale = await staleContent(path);
	if (stale === undefined) return false;
	const takeover = join(base, TAKEOVER_FILE);
	if (!(await tryCreate(base, takeover, { pid: process.pid, host: hostname(), nonce: randomUUID() }))) {
		const crashed = await staleContent(takeover);
		if (crashed !== undefined) await removeIfUnchanged(base, takeover, crashed);
		return false;
	}
	try {
		return await removeIfUnchanged(base, path, stale);
	} finally {
		await rm(takeover, { force: true });
	}
}

/**
 * Deletes `path` only if it still holds exactly `seen`: the file is first renamed to a name nobody else
 * uses, so what is compared is what gets deleted. Anything else is put back, so a live lock (or takeover)
 * that replaced the stale one is never removed.
 */
async function removeIfUnchanged(base: string, path: string, seen: string): Promise<boolean> {
	const moved = join(base, `${LOCK_FILE}.removing.${randomUUID()}`);
	try {
		await rename(path, moved);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
	try {
		if ((await readFile(moved, "utf8")) === seen) return true;
		await link(moved, path).catch(() => undefined);
		return false;
	} finally {
		await rm(moved, { force: true });
	}
}

/** The file's content when it is stale (its holder is a dead process on this host, or it is unreadable and old). */
async function staleContent(path: string): Promise<string | undefined> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	const holder = parseHolder(content);
	if (holder !== undefined) return holder.host === hostname() && !isAlive(holder.pid) ? content : undefined;
	const age = await ageMs(path);
	return age !== undefined && age > UNREADABLE_STALE_MS ? content : undefined;
}

async function readHolder(path: string): Promise<Holder | undefined> {
	try {
		return parseHolder(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

function parseHolder(content: string): Holder | undefined {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const pid = "pid" in value ? value.pid : undefined;
	const host = "host" in value ? value.host : undefined;
	const nonce = "nonce" in value ? value.nonce : undefined;
	return typeof pid === "number" && typeof host === "string"
		? { pid, host, nonce: typeof nonce === "string" ? nonce : "" }
		: undefined;
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

async function takeoverFree(base: string): Promise<boolean> {
	const takeover = join(base, TAKEOVER_FILE);
	try {
		await stat(takeover);
	} catch {
		return true;
	}
	return (await staleContent(takeover)) !== undefined;
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
				// A stale lock is worth retrying only when no live takeover is removing it; otherwise wait for that.
				() =>
					staleContent(path).then(
						async (stale) => stale !== undefined && (await takeoverFree(base)) && done(resolve),
					),
				() => done(resolve),
			);
		}
		// The holder may have released between the failed create and the watcher starting; no event would follow.
		check();
	});
}
