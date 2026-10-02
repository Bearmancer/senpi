import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../../../../config.ts";

// OAuth credential record of one server, persisted at
// <agentDir>/mcp-auth/<sha256(serverName \0 serverUrl)>/tokens.json (dir 0700, file 0600).
// Records an older senpi stored by URL alone (<sha256(serverUrl)>) move to the first server that reads them.
export interface McpStoredAuth {
	accessToken?: string;
	refreshToken?: string;
	clientInfo?: OAuthClientInformationFull;
	codeVerifier?: string;
	discoveryState?: OAuthDiscoveryState;
	resource?: string;
	// Absolute expiry (epoch ms) derived from tokens.expires_in at save time.
	expiresAt?: number;
}

export interface TokenStoreLockOptions {
	retries?: number;
	stale?: number;
}

export interface TokenStoreOptions {
	serverName: string;
	serverUrl: string;
	agentDir?: string;
	lock?: TokenStoreLockOptions;
	// Test-only escape hatch: skip the cross-process lock so the refresh-race
	// control case can demonstrate the token-family invalidation it prevents.
	disableLock?: boolean;
}

const AUTH_ROOT = "mcp-auth";
const TOKENS_FILE = "tokens.json";
const INDEX_FILE = "index.json";
const DEFAULT_LOCK: Required<TokenStoreLockOptions> = { retries: 50, stale: 30_000 };

export class LockAcquireError extends Error {
	readonly lockPath: string;
	constructor(lockPath: string, cause: unknown) {
		super(
			`Could not acquire MCP auth lock at ${lockPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "LockAcquireError";
		this.lockPath = lockPath;
	}
}

export function hashServerUrl(serverUrl: string): string {
	return createHash("sha256").update(serverUrl).digest("hex");
}

export function hashServerKey(serverName: string, serverUrl: string): string {
	return createHash("sha256").update(`${serverName}\0${serverUrl}`).digest("hex");
}

export class McpTokenStore<TRecord extends McpStoredAuth = McpStoredAuth> {
	readonly serverName: string;
	readonly serverUrl: string;
	readonly #agentDir: string;
	readonly #hash: string;
	readonly #legacyHash: string;
	readonly #lock: Required<TokenStoreLockOptions>;
	readonly #disableLock: boolean;

	constructor(options: TokenStoreOptions) {
		this.serverName = options.serverName;
		this.serverUrl = options.serverUrl;
		this.#agentDir = options.agentDir ?? getAgentDir();
		this.#hash = hashServerKey(options.serverName, options.serverUrl);
		this.#legacyHash = hashServerUrl(options.serverUrl);
		this.#lock = { ...DEFAULT_LOCK, ...options.lock };
		this.#disableLock = options.disableLock ?? false;
	}

	get rootDir(): string {
		return join(this.#agentDir, AUTH_ROOT);
	}
	get dir(): string {
		return join(this.rootDir, this.#hash);
	}
	get tokensPath(): string {
		return join(this.dir, TOKENS_FILE);
	}
	get lockPath(): string {
		return join(this.dir, `${TOKENS_FILE}.lock`);
	}

	get legacyDir(): string {
		return join(this.rootDir, this.#legacyHash);
	}

	get #legacyLockFile(): string {
		return join(this.rootDir, `${this.#legacyHash}.migrate.lock`);
	}

	read(): TRecord | undefined {
		const record = readJsonFile<TRecord>(this.tokensPath);
		if (record !== undefined) return record;
		return this.#adoptLegacyRecord();
	}

	// The first server that reads a URL-keyed record takes it over; other servers with the same URL sign in again.
	// Claiming is serialized on a lock shared by every consumer of the legacy URL (keyed on the
	// legacy hash, not the per-server destination hash), so two processes cannot both read the
	// URL-keyed record before either removes it and duplicate a rotating grant across identities.
	#adoptLegacyRecord(): TRecord | undefined {
		const release = this.#acquireLegacyLockSync();
		try {
			// Recheck under the lock: another process may have already claimed the record.
			const legacyTokens = join(this.legacyDir, TOKENS_FILE);
			const legacy = readJsonFile<TRecord>(legacyTokens);
			if (legacy === undefined) return undefined;
			// Recheck the destination before writing so a delayed migrator cannot
			// overwrite a newer same-server record another process already refreshed.
			const existing = readJsonFile<TRecord>(this.tokensPath);
			if (existing !== undefined) {
				rmSync(legacyTokens, { force: true });
				return existing;
			}
			this.#writeAtomic(legacy);
			this.#writeIndex();
			rmSync(legacyTokens, { force: true });
			return legacy;
		} finally {
			release();
		}
	}

	// The lock is a file created with O_EXCL (atomic create-or-fail), keyed on the
	// legacy hash so every server of the URL contends on the same path. It is only
	// ever taken by this migration (never nested under the per-server update lock),
	// and release removes a plain file, so it cannot linger the way a directory can.
	#acquireLegacyLockSync(): () => void {
		if (this.#disableLock) return () => undefined;
		mkdirSync(this.rootDir, { mode: 0o700, recursive: true });
		const lockFile = this.#legacyLockFile;
		const stale = this.#lock.stale;
		const deadline = Date.now() + stale;
		for (;;) {
			let fd: number | undefined;
			try {
				fd = openSync(lockFile, "wx", 0o600);
				const file = fd;
				return () => {
					try {
						closeSync(file);
					} catch {
						// already closed
					}
					rmSync(lockFile, { force: true });
				};
			} catch (cause) {
				if (fd !== undefined) {
					try {
						closeSync(fd);
					} catch {
						// ignore
					}
				}
				const code = (cause as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") throw cause;
				let age = 0;
				try {
					age = Date.now() - statSync(lockFile).mtimeMs;
				} catch {
					continue; // lock vanished between attempts; retry
				}
				if (age >= stale) {
					rmSync(lockFile, { force: true });
					continue;
				}
				if (Date.now() >= deadline) {
					throw new LockAcquireError(lockFile, new Error(`legacy migration lock held for ${age}ms`));
				}
				// bounded spin; the claim window is tiny (a read + one write + one delete)
				const until = Date.now() + 20;
				while (Date.now() < until) {
					// spin
				}
			}
		}
	}

	async update(mutate: (current: TRecord | undefined) => TRecord | undefined): Promise<TRecord | undefined> {
		const release = await this.#acquire();
		try {
			const next = mutate(this.read());
			if (next === undefined) {
				this.#removeRecord();
			} else {
				this.#writeAtomic(next);
				this.#writeIndex();
			}
			return next;
		} finally {
			await release();
		}
	}

	async write(record: TRecord): Promise<void> {
		await this.update(() => record);
	}

	// Run an async critical section under the cross-process lock. The callback
	// must use readUnlocked/writeUnlocked (never update/write) to avoid
	// re-entrant lock acquisition, which proper-lockfile rejects immediately.
	async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
		const release = await this.#acquire();
		try {
			return await fn();
		} finally {
			await release();
		}
	}

	readUnlocked(): TRecord | undefined {
		return this.read();
	}

	writeUnlocked(record: TRecord | undefined): void {
		if (record === undefined) {
			this.#removeRecord();
			return;
		}
		this.#writeAtomic(record);
		this.#writeIndex();
	}

	async clear(): Promise<void> {
		const release = await this.#acquire();
		try {
			rmSync(this.dir, { force: true, recursive: true });
			rmSync(join(this.legacyDir, TOKENS_FILE), { force: true });
		} finally {
			await release().catch(() => undefined);
		}
		removeIndexEntry(this.rootDir, this.serverName, this.#hash);
	}

	#ensureDir(): void {
		mkdirSync(this.dir, { mode: 0o700, recursive: true });
		chmodSync(this.dir, 0o700);
	}

	async #acquire(): Promise<() => Promise<void>> {
		this.#ensureDir();
		if (this.#disableLock) return () => Promise.resolve();
		try {
			return await lockfile.lock(this.dir, {
				lockfilePath: this.lockPath,
				realpath: false,
				retries: { retries: this.#lock.retries, factor: 1.2, minTimeout: 20, maxTimeout: 200 },
				stale: this.#lock.stale,
			});
		} catch (cause) {
			throw new LockAcquireError(this.lockPath, cause);
		}
	}

	#writeAtomic(record: TRecord): void {
		this.#ensureDir();
		const tmp = join(this.dir, `${TOKENS_FILE}.${randomBytes(6).toString("hex")}.tmp`);
		writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.tokensPath);
		chmodSync(this.tokensPath, 0o600);
	}

	#removeTokens(): void {
		rmSync(this.tokensPath, { force: true });
	}

	#removeRecord(): void {
		this.#removeTokens();
		removeIndexEntry(this.rootDir, this.serverName, this.#hash);
	}

	#writeIndex(): void {
		writeIndexEntry(this.rootDir, this.serverName, this.#hash);
	}
}

function readJsonFile<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	const raw = readFileSync(path, "utf-8").trim();
	if (raw.length === 0) return undefined;
	return JSON.parse(raw) as T;
}

function indexPath(rootDir: string): string {
	return join(rootDir, INDEX_FILE);
}

function readIndex(rootDir: string): Record<string, string> {
	return readJsonFile<Record<string, string>>(indexPath(rootDir)) ?? {};
}

function writeIndexEntry(rootDir: string, name: string, hash: string): void {
	mkdirSync(rootDir, { mode: 0o700, recursive: true });
	const index = readIndex(rootDir);
	if (index[name] === hash) return;
	index[name] = hash;
	writeIndexAtomic(rootDir, index);
}

function removeIndexEntry(rootDir: string, name: string, hash: string): void {
	if (!existsSync(indexPath(rootDir))) return;
	const index = readIndex(rootDir);
	if (index[name] !== hash && index[name] !== undefined) return;
	delete index[name];
	writeIndexAtomic(rootDir, index);
}

function writeIndexAtomic(rootDir: string, index: Record<string, string>): void {
	const tmp = join(rootDir, `${INDEX_FILE}.${randomBytes(6).toString("hex")}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, indexPath(rootDir));
	chmodSync(indexPath(rootDir), 0o600);
}
