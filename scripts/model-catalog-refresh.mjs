#!/usr/bin/env node
/**
 * Prepare the daily model-catalog refresh PR (senpi#2943).
 *
 * After `generate-models` regenerated the catalog in a clean checkout of `main`, this script reads which
 * catalog files changed, writes a per-provider summary for the PR body, and records one CHANGELOG entry
 * under `## [Unreleased]` / `### Changed` in `packages/ai/CHANGELOG.md`. It prints `changed=true|false`
 * for `$GITHUB_OUTPUT`. The refresh PR is then merged by GitHub auto-merge once its required CI is green,
 * so a release normally finds no catalog drift and reuses CI instead of waiting for it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { REGENERATED_CATALOG_PATHS } from "./release-test-gate.mjs";

export const REFRESH_ENTRY_PREFIX = "- The bundled model catalog is refreshed from models.dev";

const PROVIDERS_DIR = "packages/ai/src/providers/";

/**
 * @param {string} porcelain `git status --porcelain --untracked-files=all` output for the catalog paths
 * @returns {{providers: string[], files: string[]}}
 */
export function changedCatalog(porcelain) {
	const files = porcelain
		.split("\n")
		.map((line) => line.slice(3).trim())
		.filter((file) => file.length > 0)
		.map((file) => (file.includes(" -> ") ? file.slice(file.indexOf(" -> ") + 4) : file))
		.sort();
	const providers = new Set();
	for (const file of files) {
		if (!file.startsWith(PROVIDERS_DIR)) continue;
		const name = file.slice(PROVIDERS_DIR.length).replace(/^data\//, "");
		if (name.startsWith(".") || name.includes("/")) continue;
		providers.add(name.replace(/\.(json|ts)$/, ""));
	}
	return { providers: [...providers].sort(), files };
}

/**
 * @param {string[]} providers
 * @returns {string}
 */
export function refreshEntry(providers) {
	const list = providers.length > 0 ? providers.map((id) => `\`${id}\``).join(", ") : "the catalog aggregate";
	return `${REFRESH_ENTRY_PREFIX} and the providers' model listings (${list}).`;
}

/**
 * Put exactly one refresh entry under `## [Unreleased]` / `### Changed`, replacing an earlier one.
 * @param {string} changelog
 * @param {string[]} providers
 * @returns {string}
 */
export function withRefreshEntry(changelog, providers) {
	const entry = refreshEntry(providers);
	const lines = changelog.split("\n").filter((line) => !line.startsWith(REFRESH_ENTRY_PREFIX));
	const unreleased = lines.findIndex((line) => line.trim() === "## [Unreleased]");
	if (unreleased < 0) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
	const nextRelease = lines.findIndex((line, index) => index > unreleased && line.startsWith("## "));
	const end = nextRelease < 0 ? lines.length : nextRelease;
	const changed = lines.findIndex((line, index) => index > unreleased && index < end && line.trim() === "### Changed");
	if (changed >= 0) {
		lines.splice(changed + 1, 0, "", entry);
	} else {
		lines.splice(end, 0, "### Changed", "", entry, "");
	}
	return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * @param {{providers: string[], files: string[]}} change
 * @returns {string}
 */
export function summaryMarkdown(change) {
	return [
		"## Model catalog refresh",
		"",
		`The daily regeneration changed ${change.files.length} catalog file(s) for ${change.providers.length} provider(s): ${change.providers.map((id) => `\`${id}\``).join(", ") || "none (aggregate only)"}.`,
		"",
		"<details><summary>Changed files</summary>",
		"",
		...change.files.map((file) => `- \`${file}\``),
		"",
		"</details>",
		"",
		"This PR merges automatically once its required checks are green, so a release finds no catalog drift and reuses CI (#2943). When CI is red, typically a test that pins a model the catalog no longer lists (#2584), it stays open, and the scheduled run fails after it has waited too long.",
		"",
	].join("\n");
}

function main(argv) {
	const changelogPath = argv[argv.indexOf("--changelog") + 1];
	const summaryPath = argv[argv.indexOf("--summary") + 1];
	if (!argv.includes("--changelog") || !argv.includes("--summary")) {
		throw new Error("usage: node scripts/model-catalog-refresh.mjs --changelog <CHANGELOG.md> --summary <out.md>");
	}
	const porcelain = execFileSync(
		"git",
		["status", "--porcelain", "--untracked-files=all", "--", ...REGENERATED_CATALOG_PATHS],
		{ encoding: "utf8" },
	);
	const change = changedCatalog(porcelain);
	if (change.files.length === 0) {
		process.stdout.write("changed=false\n");
		return;
	}
	writeFileSync(changelogPath, withRefreshEntry(readFileSync(changelogPath, "utf8"), change.providers));
	writeFileSync(summaryPath, summaryMarkdown(change));
	process.stdout.write("changed=true\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`[model-catalog-refresh] error: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
	}
}
