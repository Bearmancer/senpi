import { access } from "node:fs/promises";
import { RESOLUTION_TIMED_OUT, withResolutionDeadline } from "../../../tools/bounded-realpath.ts";
import { canonicalizeFilesystemPath } from "../../../tools/filesystem-policy.ts";
import { type MovedPath, readJsonFileAsync } from "./breadcrumb-trust.ts";
import { currentPathPlatform, type PathPlatform } from "./path-match.ts";
import { failedReply, movedPathWalk, type ResolverStep } from "./walk.ts";

/** Each filesystem step of a probe; strictly below the guard's whole-call deadline, so one slow step cannot use it all. */
export const STEP_DEADLINE_MS = 500;

export type MovedPathProbe = (path: string) => Promise<MovedPath | undefined>;

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function answer(step: ResolverStep): Promise<unknown> {
	const io =
		step.op === "canonical"
			? canonicalizeFilesystemPath(step.path)
			: step.op === "json"
				? readJsonFileAsync(step.file)
				: pathExists(step.path);
	try {
		const reply = await withResolutionDeadline(io, STEP_DEADLINE_MS);
		return reply === RESOLUTION_TIMED_OUT ? failedReply(step) : reply;
	} catch {
		return failedReply(step);
	}
}

/**
 * Resolution for one tool call (senpi#2898): the same walk as `findMovedPath`, with asynchronous, deadline-bounded
 * I/O (`canonicalizeFilesystemPath`), so a wedged mount never blocks the session loop. A step whose I/O fails or
 * times out answers as "not moved"; resolution never throws into the tool call.
 */
export function createMovedPathProbe(platform: PathPlatform = currentPathPlatform()): MovedPathProbe {
	return async (path) => {
		const walk = movedPathWalk(path, platform);
		let step = walk.next();
		while (!step.done) step = walk.next(await answer(step.value));
		return step.value;
	};
}
