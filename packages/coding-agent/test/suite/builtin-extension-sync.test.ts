import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const builtinRoot = join(process.cwd(), "src", "core", "extensions", "builtin");

describe("synced builtin extensions", () => {
	it("records the external source package versions used for vendored builtins", () => {
		const manifestPath = join(builtinRoot, "external-versions.json");

		expect(existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
			extensions?: Record<string, { packageName?: string; version?: string; source?: string }>;
		};

		// senpi#2079: pinned to the 2026-09-24 pi-* extension releases.
		expect(manifest.extensions).toEqual({
			"bash-timeout": {
				packageName: "pi-bash-timeout",
				version: "0.1.2",
				source: "../pi-extensions/pi-bash-timeout",
			},
			"gpt-apply-patch": {
				packageName: "pi-apply-patch",
				version: "0.1.3",
				source: "../pi-extensions/pi-apply-patch",
			},
			todowrite: { packageName: "pi-todotools", version: "0.2.1", source: "../pi-extensions/pi-todotools" },
			goal: { packageName: "pi-goal", version: "0.3.1", source: "../pi-extensions/pi-goal" },
			websearch: { packageName: "pi-websearch", version: "0.4.0", source: "../pi-extensions/pi-websearch" },
			webfetch: { packageName: "pi-webfetch", version: "0.1.3", source: "../pi-extensions/pi-webfetch" },
			"nested-agents-md": {
				packageName: "@code-yeongyu/pi-nested-agents-md",
				version: "0.1.1",
				source: "../pi-extensions/pi-nested-agents-md",
			},
			rules: { packageName: "@code-yeongyu/pi-rules", version: "0.2.0", source: "../pi-extensions/pi-rules" },
			"anthropic-web-search": {
				packageName: "pi-anthropic-web-search",
				version: "0.1.1",
				source: "../pi-extensions/pi-anthropic-web-search",
			},
			"openai-web-search": {
				packageName: "pi-openai-web-search",
				version: "0.1.1",
				source: "../pi-extensions/pi-openai-web-search",
			},
			"anthropic-bash": {
				packageName: "pi-anthropic-bash",
				version: "0.1.1",
				source: "../pi-extensions/pi-anthropic-bash",
			},
		});
	});

	it("keeps an existing builtin directory for every pinned vendored package", () => {
		const manifest = JSON.parse(readFileSync(join(builtinRoot, "external-versions.json"), "utf-8")) as {
			extensions: Record<string, unknown>;
		};
		const directoryFor = (id: string): string => (id === "todowrite" ? "todotools" : id);

		for (const id of Object.keys(manifest.extensions)) {
			expect(existsSync(join(builtinRoot, directoryFor(id), "index.ts")), id).toBe(true);
		}
	});
});
