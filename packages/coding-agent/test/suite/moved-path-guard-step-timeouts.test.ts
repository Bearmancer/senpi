import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createMovedLayout, type MovedLayout, runTool } from "./moved-path-guard-fixtures.ts";

// code-yeongyu/senpi#2898 fourth review M-d: when a breadcrumb read or a .git check times out, the guard decides the
// way its text fallback does: a moved prefix trusted earlier is still refused, and a worktree the probe found re-used
// is still allowed. The slow steps never settle, so the guard's own deadlines decide.

const stall = vi.hoisted(() => ({ breadcrumb: "", git: false }));

vi.mock("../../src/core/extensions/builtin/moved-path-guard/breadcrumb-trust.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/core/extensions/builtin/moved-path-guard/breadcrumb-trust.ts")>();
	return {
		...actual,
		readJsonFileAsync: (file: string) =>
			file === stall.breadcrumb ? new Promise<unknown>(() => {}) : actual.readJsonFileAsync(file),
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		access: (path: string, mode?: number) =>
			stall.git && String(path).endsWith(".git") ? new Promise<void>(() => {}) : actual.access(path, mode),
	};
});

const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");

describe("moved-path-guard step timeouts on breadcrumb and .git (#2898)", () => {
	const layouts: MovedLayout[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		stall.breadcrumb = "";
		stall.git = false;
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	async function setup(cwd?: (layout: MovedLayout) => string) {
		if (!guard) throw new Error("moved-path-guard is not registered");
		const layout = createMovedLayout();
		layouts.push(layout);
		const harness = await createHarness({
			cwd: cwd?.(layout) ?? layout.home,
			extensionFactories: [guard.factory],
			initialActiveToolNames: ["bash"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { layout, harness };
	}

	it("refuses a trusted moved path whose breadcrumb read times out", async () => {
		const { layout, harness } = await setup();
		expect(await runTool(harness, "bash", { command: `touch ${layout.oldWorktree}/a` })).toMatchObject({
			outcome: "blocked",
		});
		// Only the old root's breadcrumb is slow, so the call stays well inside its own deadline.
		stall.breadcrumb = join(layout.oldRoot, "omo-desktop-moved.json");

		const result = await runTool(harness, "bash", { command: `touch ${layout.oldWorktree}/b` });

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(join(layout.newWorktree, "b"));
	});

	it("allows a re-used worktree whose .git check times out", async () => {
		const { harness } = await setup((moved) => {
			mkdirSync(join(moved.oldWorktree, "src"), { recursive: true });
			writeFileSync(join(moved.oldWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w1\n");
			return moved.oldWorktree;
		});
		expect(await runTool(harness, "bash", { command: "touch src/a.ts" })).toMatchObject({ outcome: "ok" });
		stall.git = true;

		const result = await runTool(harness, "bash", { command: "touch src/b.ts" });

		expect(result.outcome).toBe("ok");
	});
});
