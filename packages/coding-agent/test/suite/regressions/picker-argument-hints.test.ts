import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSkillsFromDir, type Skill } from "../../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

vi.mock("../../../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

// omo #9042 A: a command takes arguments iff its metadata declares an argument hint, and the hint
// reaches the picker row as a machine-readable `awaitsArguments` flag.

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeSkill(frontmatter: string): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-skill-hint-"));
	tempDirs.push(root);
	const dir = join(root, "plan-runner");
	mkdirSync(dir);
	writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\nBody\n`);
	return root;
}

type ProviderOwner = {
	createBaseAutocompleteProvider(this: object): AutocompleteProvider;
	prefixAutocompleteDescription(this: object, description: string | undefined): string | undefined;
	getAutocompleteSourceTag(this: object): string | undefined;
};

function providerFor(options: {
	readonly extensionCommands: readonly { name: string; argumentHint?: string }[];
	readonly skills: readonly Skill[];
}): AutocompleteProvider {
	const prototype = InteractiveMode.prototype as unknown as ProviderOwner;
	const sourceInfo = createSyntheticSourceInfo("/tmp/ext.ts", { source: "test" });
	const fakeThis = {
		session: {
			scopedModels: [],
			modelRuntime: { getAvailableSnapshot: () => [] },
			promptTemplates: [],
			extensionRunner: {
				getRegisteredCommands: () =>
					options.extensionCommands.map((command) => ({ ...command, invocationName: command.name, sourceInfo })),
			},
			resourceLoader: { getSkills: () => ({ skills: options.skills }) },
		},
		settingsManager: { getEnableSkillCommands: () => true },
		skillCommands: new Map<string, string>(),
		sessionManager: { getCwd: () => "/tmp" },
		fdPath: null,
		prefixAutocompleteDescription: prototype.prefixAutocompleteDescription,
		getAutocompleteSourceTag: prototype.getAutocompleteSourceTag,
	};
	return prototype.createBaseAutocompleteProvider.call(fakeThis);
}

async function rowsFor(provider: AutocompleteProvider, line: string) {
	const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	return new Map(suggestions?.items.map((item) => [item.value, item.awaitsArguments === true]));
}

describe("command argument hints reach the picker", () => {
	it("parses a skill's argument-hint frontmatter", () => {
		const dir = writeSkill("name: plan-runner\ndescription: Runs a plan\nargument-hint: <plan-name>");

		const { skills } = loadSkillsFromDir({ dir, source: "test" });

		expect(skills.map((skill) => skill.argumentHint)).toEqual(["<plan-name>"]);
	});

	it("leaves argumentHint unset for a skill without the frontmatter field", () => {
		const dir = writeSkill("name: plan-runner\ndescription: Runs a plan");

		const { skills } = loadSkillsFromDir({ dir, source: "test" });

		expect(skills[0]?.argumentHint).toBeUndefined();
	});

	it("marks hinted extension commands and skills as awaiting arguments, and only those", async () => {
		const skillInfo = createSyntheticSourceInfo("/tmp/s/SKILL.md", { source: "test" });
		const skill = (name: string, argumentHint?: string): Skill => ({
			name,
			description: `${name} skill`,
			filePath: `/tmp/${name}/SKILL.md`,
			baseDir: `/tmp/${name}`,
			sourceInfo: skillInfo,
			disableModelInvocation: false,
			...(argumentHint !== undefined && { argumentHint }),
		});
		const provider = providerFor({
			extensionCommands: [{ name: "ask", argumentHint: "<question>" }, { name: "audit" }],
			skills: [skill("plan-runner", "<plan>"), skill("plan-lint")],
		});

		const commandRows = await rowsFor(provider, "/a");
		const skillRows = await rowsFor(provider, "/skill:plan");

		expect(commandRows.get("ask")).toBe(true);
		expect(commandRows.get("audit")).toBe(false);
		expect(skillRows.get("skill:plan-runner")).toBe(true);
		expect(skillRows.get("skill:plan-lint")).toBe(false);
	});
});
