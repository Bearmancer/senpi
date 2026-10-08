import { access } from "node:fs/promises";
import { RESOLUTION_TIMED_OUT, withResolutionDeadline } from "../../../tools/bounded-realpath.ts";
import { canonicalizeFilesystemPath } from "../../../tools/filesystem-policy.ts";
import type { MovedBreadcrumb } from "./breadcrumb.ts";
import { type MovedPath, readJsonFileAsync } from "./breadcrumb-trust.ts";
import { knownPrefixKeys, prefixKey } from "./known-moves.ts";
import { currentPathPlatform, type PathPlatform } from "./path-match.ts";
import { failedReply, movedPathWalk, type ResolverStep } from "./walk.ts";

/** Each filesystem step of a probe; strictly below the guard's whole-call deadline, so one slow step cannot use it all. */
export const STEP_DEADLINE_MS = 500;

export interface MovedPathProbe {
	resolve(path: string): Promise<MovedPath | undefined>;
	/** Whether any filesystem step of this probe hit `STEP_DEADLINE_MS`. */
	readonly timedOut: boolean;
	/** Whether `path` lies under a listed prefix this probe found re-used (its own `.git`): never moved. */
	cleared(path: string): boolean;
	/** After this, every remaining step answers `failedReply` without filesystem work (the call's deadline passed). */
	stop(): void;
	readonly stopped: boolean;
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function answer(step: ResolverStep, onTimeout: () => void): Promise<unknown> {
	const io =
		step.op === "canonical"
			? canonicalizeFilesystemPath(step.path)
			: step.op === "json"
				? readJsonFileAsync(step.file)
				: pathExists(step.path);
	try {
		const reply = await withResolutionDeadline(io, STEP_DEADLINE_MS);
		if (reply !== RESOLUTION_TIMED_OUT) return reply;
		onTimeout();
		return failedReply(step);
	} catch {
		return failedReply(step);
	}
}

/**
 * Resolution for one tool call (senpi#2898): the same walk as `findMovedPath`, with asynchronous, deadline-bounded
 * I/O (`canonicalizeFilesystemPath`), so a wedged mount never blocks the session loop. A step whose I/O fails or
 * times out gets `failedReply`; resolution never throws into the tool call, and the probe records a timeout.
 */
export function createMovedPathProbe(platform: PathPlatform = currentPathPlatform()): MovedPathProbe {
	let timedOut = false;
	let stopped = false;
	const reused = new Set<string>();
	const onReused = (oldRoot: string, breadcrumb: MovedBreadcrumb, prefix: readonly string[]) =>
		reused.add(prefixKey(oldRoot, breadcrumb, prefix));
	const onTimeout = () => {
		timedOut = true;
	};
	return {
		get timedOut() {
			return timedOut;
		},
		get stopped() {
			return stopped;
		},
		stop() {
			stopped = true;
		},
		cleared(path) {
			return knownPrefixKeys(path, platform).some((key) => reused.has(key));
		},
		async resolve(path) {
			const walk = movedPathWalk(path, platform, onReused);
			let step = walk.next();
			while (!step.done) step = walk.next(stopped ? failedReply(step.value) : await answer(step.value, onTimeout));
			return step.value;
		},
	};
}
