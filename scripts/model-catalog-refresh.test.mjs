#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changedCatalog, REFRESH_ENTRY_PREFIX, summaryMarkdown, withRefreshEntry } from "./model-catalog-refresh.mjs";

const CHANGELOG = `# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Something new.

### Changed

- An earlier change.

## [2026.10.8] - 2026-10-08

### Changed

- Released change.
`;

describe("changedCatalog (senpi#2943)", () => {
	it("names each provider whose data or shard changed, once", () => {
		const change = changedCatalog(
			[
				" M packages/ai/src/models.generated.ts",
				" M packages/ai/src/providers/data/nvidia.json",
				" M packages/ai/src/providers/nvidia.ts",
				"?? packages/ai/src/providers/data/newco.json",
				" M packages/ai/src/providers/data/.manifest.json",
			].join("\n"),
		);
		assert.deepEqual(change.providers, ["newco", "nvidia"]);
		assert.equal(change.files.length, 5);
	});

	it("reports nothing when the regeneration left the catalog unchanged", () => {
		assert.deepEqual(changedCatalog(""), { providers: [], files: [] });
	});
});

describe("withRefreshEntry (senpi#2943)", () => {
	it("adds the entry under Unreleased / Changed, not under a released section", () => {
		const out = withRefreshEntry(CHANGELOG, ["nvidia"]);
		const unreleased = out.slice(0, out.indexOf("## [2026.10.8]"));
		assert.match(unreleased, /### Changed\n\n- The bundled model catalog is refreshed .*`nvidia`/);
		assert.equal(out.slice(out.indexOf("## [2026.10.8]")), CHANGELOG.slice(CHANGELOG.indexOf("## [2026.10.8]")));
		assert.match(unreleased, /- An earlier change\./);
	});

	it("replaces an earlier refresh entry instead of stacking a second one", () => {
		const once = withRefreshEntry(CHANGELOG, ["nvidia"]);
		const twice = withRefreshEntry(once, ["nvidia", "openrouter"]);
		assert.equal(twice.split(REFRESH_ENTRY_PREFIX).length - 1, 1);
		assert.match(twice, /`nvidia`, `openrouter`/);
	});

	it("creates a Changed subsection when Unreleased has none", () => {
		const out = withRefreshEntry("# Changelog\n\n## [Unreleased]\n\n### Added\n\n- New.\n\n## [1] - 2026-01-01\n", ["x"]);
		assert.match(out, /### Added\n\n- New\.\n\n### Changed\n\n- The bundled model catalog .*`x`.*\n\n## \[1\]/);
	});

	it("refuses a changelog without an Unreleased section", () => {
		assert.throws(() => withRefreshEntry("# Changelog\n\n## [1] - 2026-01-01\n", ["x"]), /no ## \[Unreleased\]/);
	});
});

describe("summaryMarkdown (senpi#2943)", () => {
	it("lists the providers and files the refresh changed", () => {
		const md = summaryMarkdown({ providers: ["nvidia"], files: ["packages/ai/src/providers/data/nvidia.json"] });
		assert.match(md, /1 catalog file\(s\) for 1 provider\(s\): `nvidia`/);
		assert.match(md, /- `packages\/ai\/src\/providers\/data\/nvidia\.json`/);
	});
});
