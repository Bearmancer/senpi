import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { sessionCwdMatcher } from "./moved-session-cwd.ts";
import { compareRepositoryIdentities, type RepositoryIdentity, readRepositoryIdentity } from "./repository-identity.ts";
import { listSessionsFromDir } from "./session-discovery.ts";
import { getDefaultSessionDir, type SessionInfo } from "./session-manager.ts";
import { readFileLines } from "./session-summary.ts";

// A session is "moved" when it belongs to the current repository (by its recorded identity) and was
// recorded at a path that no longer exists: the repository moved away from it. A live second checkout
// is not moved, and an unrecorded or different repository never matches.

export interface MovedSessionOptions {
	readonly sessionDir?: string;
	readonly readIdentity?: (dir: string) => Promise<RepositoryIdentity | undefined>;
}

// A session recorded at a vanished path is "here" when the OmO desktop moved that path to `cwd`: it is this folder's
// own session, listed without the moved badge and never rebound (senpi#2990). Otherwise it may be a moved one.
type VanishedKind = "here" | "moved";

function vanishedClassifier(
	cwd: string,
	current: RepositoryIdentity,
): (session: SessionInfo) => VanishedKind | undefined {
	const ownCwd = sessionCwdMatcher(cwd);
	return (session) => {
		if (!session.cwd || resolvePath(session.cwd) === cwd || existsSync(session.cwd)) return undefined;
		if (ownCwd(session.cwd)) return "here";
		return compareRepositoryIdentities(session.repositoryIdentity, current) === "same" ? "moved" : undefined;
	};
}

function newestFirst(a: SessionInfo, b: SessionInfo): number {
	return b.modified.getTime() - a.modified.getTime();
}

async function recordedCwd(dir: string): Promise<string | undefined> {
	const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
	for (const name of names) {
		let firstLine: string | undefined;
		try {
			await readFileLines(join(dir, name), (line) => {
				firstLine = line;
				return false;
			});
			const header: unknown = JSON.parse(firstLine ?? "");
			if (typeof header === "object" && header !== null && "cwd" in header && typeof header.cwd === "string") {
				return header.cwd;
			}
		} catch (error) {
			if (!(error instanceof Error)) throw error;
		}
	}
	return undefined;
}

// Each project directory holds one cwd, so one header decides whether its sessions can be moved ones;
// only directories whose recorded path is gone are listed in full.
async function sessionsAtVanishedPaths(cwd: string): Promise<SessionInfo[]> {
	const root = getSessionsDir();
	if (!existsSync(root)) return [];
	const own = normalizePath(getDefaultSessionDir(cwd));
	const sessions: SessionInfo[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		if (normalizePath(dir) === own) continue;
		const recorded = await recordedCwd(dir);
		if (recorded === undefined || existsSync(recorded)) continue;
		sessions.push(...(await listSessionsFromDir(dir)));
	}
	return sessions;
}

/**
 * One scan of the sessions recorded at vanished paths: `here` (the OmO desktop moved the path to `cwd`; senpi#2990)
 * and `moved` (badged repository moves), each newest first.
 */
export async function listVanishedSessions(
	cwd: string,
	options: MovedSessionOptions = {},
): Promise<Record<VanishedKind, SessionInfo[]>> {
	const found: Record<VanishedKind, SessionInfo[]> = { here: [], moved: [] };
	const here = resolvePath(cwd);
	const current = await (options.readIdentity ?? readRepositoryIdentity)(here);
	if (current === undefined) return found;
	const candidates = options.sessionDir
		? await listSessionsFromDir(normalizePath(options.sessionDir))
		: await sessionsAtVanishedPaths(here);
	const classify = vanishedClassifier(here, current);
	for (const session of candidates) {
		const kind = classify(session);
		if (kind === "moved") found.moved.push({ ...session, moved: true });
		else if (kind === "here") found.here.push(session);
	}
	found.here.sort(newestFirst);
	found.moved.sort(newestFirst);
	return found;
}

export async function listMovedSessions(cwd: string, options: MovedSessionOptions = {}): Promise<SessionInfo[]> {
	return (await listVanishedSessions(cwd, options)).moved;
}

export async function markMovedSessions(
	sessions: readonly SessionInfo[],
	cwd: string,
	options: Pick<MovedSessionOptions, "readIdentity"> = {},
): Promise<SessionInfo[]> {
	const here = resolvePath(cwd);
	const current = await (options.readIdentity ?? readRepositoryIdentity)(here);
	if (current === undefined) return [...sessions];
	const classify = vanishedClassifier(here, current);
	return sessions.map((session) => (classify(session) === "moved" ? { ...session, moved: true } : session));
}

export async function withMovedSessions(
	local: Promise<SessionInfo[]>,
	cwd: string,
	options: MovedSessionOptions = {},
): Promise<SessionInfo[]> {
	const [own, vanished] = await Promise.all([local, listVanishedSessions(cwd, options)]);
	// A shared session dir lists a desktop-moved session in both: one row, the folder's own.
	const listed = new Set(own.map((session) => session.path));
	const extra = [...vanished.here, ...vanished.moved].filter((session) => !listed.has(session.path));
	return [...own, ...extra].sort(newestFirst);
}
