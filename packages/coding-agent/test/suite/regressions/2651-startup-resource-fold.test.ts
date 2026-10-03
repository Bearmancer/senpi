import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { LoadedResourceSection } from "../../../src/modes/interactive/components/loaded-resource-section.ts";

const INTERACTIVE_MODE_SOURCE = readFileSync(
	fileURLToPath(new URL("../../../src/modes/interactive/interactive-mode.ts", import.meta.url)),
	"utf8",
);

function renderAll(container: Container): string {
	return container.render(120).flat().join("\n");
}

// Regression for https://github.com/code-yeongyu/senpi/issues/2651
describe("startup resource banner folds to a one-line summary", () => {
	const names = Array.from({ length: 69 }, (_, i) => `skill-${String(i).padStart(2, "0")}`);

	test("a compact summary line carries the section header and count, no names", () => {
		const section = new LoadedResourceSection(
			() => "[Skills] 69",
			() => `[Skills]\n${names.join("\n")}`,
			false,
		);
		const container = new Container();
		container.addChild(section);
		const rendered = renderAll(container);

		expect(rendered).toContain("[Skills]");
		expect(rendered).toContain("69");
		for (const name of names.slice(0, 5)) {
			expect(rendered).not.toContain(name);
		}
	});

	test("expanding reveals the full list", () => {
		const section = new LoadedResourceSection(
			() => "[Skills] 69",
			() => `[Skills]\n${names.join("\n")}`,
			false,
		);
		section.setExpanded(true);
		const container = new Container();
		container.addChild(section);
		const rendered = renderAll(container);

		expect(rendered).toContain("skill-00");
		expect(rendered).toContain("skill-68");
	});

	test("the compact banner no longer joins every loaded name inline", () => {
		// The compact body must be a summary, not the full list: labels.join(", ") is what dumped
		// all 69 skill names onto the first screen. It must not back the collapsed section bodies.
		expect(INTERACTIVE_MODE_SOURCE).toContain("formatSummary(");
		expect(INTERACTIVE_MODE_SOURCE).not.toMatch(/const skillCompactList = \(\) =>\s*\n?\s*formatCompactList/);
	});
});
