#!/usr/bin/env node
/**
 * Decide whether the release test gate must run the full suite locally.
 *
 * The canonical release flow already requires CI green on `main` before a release
 * commit is cut, so re-running `CI=1 npm test` locally duplicates a gate GitHub
 * already ran for the exact same tree. This module answers one question: does HEAD
 * already carry a green "Check and test" check run? Pure decision logic lives here
 * (unit-testable without network); `release.mjs` owns the `gh` lookup.
 */

import { execFileSync } from "node:child_process";

export const REQUIRED_CHECK_NAME = "Check and test";

/** What `packages/ai/scripts/generate-models.ts` writes: the aggregator and the provider shards/data. */
export const REGENERATED_CATALOG_PATHS = ["packages/ai/src/models.generated.ts", "packages/ai/src/providers"];

/**
 * True when the release's catalog regeneration left the catalog different from HEAD (a changed or a
 * new file). HEAD's CI ran on the old catalog, so it says nothing about the regenerated one (senpi#2645).
 * @param {string} cwd repository root
 */
export function catalogChangedSinceHead(cwd) {
	const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...REGENERATED_CATALOG_PATHS], {
		cwd,
		encoding: "utf8",
	});
	return status.trim().length > 0;
}

/**
 * @param {Array<{name: string, status: string, conclusion: string|null, head_sha: string}>} checkRuns
 * @param {string} sha
 */
export function isCiCheckGreen(checkRuns, sha) {
	return checkRuns.some(
		(run) =>
			run.name === REQUIRED_CHECK_NAME &&
			run.status === "completed" &&
			run.conclusion === "success" &&
			run.head_sha === sha,
	);
}

const SUPERSEDED_CONCLUSIONS = new Set(["cancelled", "stale", "skipped"]);

/**
 * What the release does with the "Check and test" runs CI reported for `sha` (senpi#2943). That fan-in check
 * succeeds only when every CI shard and required job passed, so a green one is the release's test evidence and
 * the release never re-runs the suite itself.
 * @param {{sha: string, checkRuns: Array<{name: string, status: string, conclusion: string|null, head_sha: string, id?: number}>|null}} input
 *   checkRuns === null means the lookup failed (offline, gh missing, API error).
 * @returns {{action: "reuse"|"wait"|"stop"|"superseded", reason: string}}
 */
export function planCiEvidence({ sha, checkRuns }) {
	const short = sha.slice(0, 12);
	if (checkRuns === null) return { action: "wait", reason: `the CI lookup for ${short} failed` };
	const runs = checkRuns
		.map((run, index) => ({ run, order: run.id ?? index }))
		.filter(({ run }) => run.name === REQUIRED_CHECK_NAME && run.head_sha === sha)
		.sort((a, b) => a.order - b.order)
		.map(({ run }) => run);
	const latest = runs.at(-1);
	if (!latest) return { action: "wait", reason: `no "${REQUIRED_CHECK_NAME}" run for ${short} yet` };
	if (latest.status !== "completed") {
		return { action: "wait", reason: `"${REQUIRED_CHECK_NAME}" for ${short} is ${latest.status}` };
	}
	if (latest.conclusion === "success") {
		return { action: "reuse", reason: `${short} has a green "${REQUIRED_CHECK_NAME}" run; it is the release's test evidence` };
	}
	if (SUPERSEDED_CONCLUSIONS.has(latest.conclusion ?? "")) {
		return { action: "superseded", reason: `"${REQUIRED_CHECK_NAME}" for ${short} was ${latest.conclusion}` };
	}
	return { action: "stop", reason: `"${REQUIRED_CHECK_NAME}" for ${short} concluded ${latest.conclusion}` };
}

/**
 * Wait until HEAD (or the main commit that superseded its CI run) has a green "Check and test" run, and return
 * that commit. Never runs the suite: a red run stops the release, and no result within `timeoutMs` fails it with
 * the reason, so an operator reruns CI rather than the release re-running the whole suite serially.
 * @param {{timeoutMs: number, pollMs: number}} options
 * @param {{
 *   lookupCheckRuns: (sha: string) => Array|null,
 *   sleep: (ms: number) => void,
 *   now: () => number,
 *   headSha: () => string,
 *   newerMainContaining: (sha: string) => string|undefined,
 *   fastForwardTo: (sha: string) => void,
 *   log: (message: string) => void,
 * }} deps
 * @returns {string} the commit whose green CI the release reuses
 */
export function awaitCiEvidence({ timeoutMs, pollMs }, deps) {
	const startedAt = deps.now();
	let sha = deps.headSha();
	for (;;) {
		const plan = planCiEvidence({ sha, checkRuns: deps.lookupCheckRuns(sha) });
		deps.log(`test gate: ${plan.reason}`);
		if (plan.action === "reuse") return sha;
		if (plan.action === "stop") throw new Error(`CI failed on ${sha.slice(0, 12)}: ${plan.reason}; fix main before releasing`);
		if (plan.action === "superseded") {
			const newer = deps.newerMainContaining(sha);
			if (newer) {
				deps.log(`test gate: main moved to ${newer.slice(0, 12)}; releasing that commit once its CI is green`);
				deps.fastForwardTo(newer);
				sha = newer;
				continue;
			}
		}
		if (deps.now() - startedAt >= timeoutMs) {
			throw new Error(
				`no ${REQUIRED_CHECK_NAME} result for ${sha.slice(0, 12)} within ${Math.round(timeoutMs / 60_000)} min; rerun CI on it, or pass --force-tests to run the suite in this job`,
			);
		}
		deps.sleep(pollMs);
	}
}
