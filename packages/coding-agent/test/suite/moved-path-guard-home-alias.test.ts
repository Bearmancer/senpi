import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createMovedLayout, MOVED_WORKTREE, type MovedLayout, runTool } from "./moved-path-guard-fixtures.ts";

// code-yeongyu/senpi#2898 fifth review M-2: on a host whose $HOME is a symlink, a trusted breadcrumb's old root is the
// realpath spelling while commands name `~/.t3/...` in the $HOME spelling. The text fallback and the probe ranking must
// match both spellings, or a moved target past the probe budget or after a step timeout is allowed. Node's
// `os.homedir()` follows a runtime $HOME change (Bun's does not), so these run under vitest/node.

const stall = vi.hoisted(() => ({ breadcrumb: "" }));

vi.mock("../../src/core/extensions/builtin/moved-path-guard/breadcrumb-trust.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/core/extensions/builtin/moved-path-guard/breadcrumb-trust.ts")>();
	return {
		...actual,
		readJsonFileAsync: (file: string) =>
			file === stall.breadcrumb ? new Promise<unknown>(() => {}) : actual.readJsonFileAsync(file),
	};
});

const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");
const UNLISTED = Array.from({ length: 70 }, (_, index) => `~/.t3/unlisted/d${index}`).join(" ");

describe.each([
	["a symlinked $HOME", true],
	["an unaliased $HOME", false],
])("moved-path-guard text fallback with %s (#2898)", (_label, aliased) => {
	const layouts: MovedLayout[] = [];
	const harnesses: Harness[] = [];
	const links: string[] = [];

	afterEach(() => {
		stall.breadcrumb = "";
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (links.length > 0) rmSync(links.pop() ?? "", { force: true });
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	async function trusted() {
		if (!guard) throw new Error("moved-path-guard is not registered");
		const layout = createMovedLayout();
		layouts.push(layout);
		if (aliased) {
			const link = `${layout.home}-link`;
			symlinkSync(layout.home, link);
			links.push(link);
			vi.stubEnv("HOME", link);
		}
		const harness = await createHarness({
			cwd: layout.home,
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["bash"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(await runTool(harness, "bash", { command: `touch ~/.t3/${MOVED_WORKTREE}/a` })).toMatchObject({
			outcome: "blocked",
		});
		return { layout, harness };
	}

	it("refuses a moved target behind 70 unlisted legacy paths", async () => {
		const { layout, harness } = await trusted();

		const result = await runTool(harness, "bash", { command: `touch ${UNLISTED} ~/.t3/${MOVED_WORKTREE}/b` });

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(join(layout.newWorktree, "b"));
	});

	it("refuses a moved target whose breadcrumb read times out", async () => {
		const { layout, harness } = await trusted();
		stall.breadcrumb = join(layout.oldRoot, "omo-desktop-moved.json");

		const result = await runTool(harness, "bash", { command: `touch ~/.t3/${MOVED_WORKTREE}/c` });

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(join(layout.newWorktree, "c"));
	});
});
