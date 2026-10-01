import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "../harness.ts";

// #2513: the user can read shipped resources, not arbitrary outside files or bundle writes.
let scratch: string;
let skillPath: string;
let harness: Harness | undefined;
const approvals: string[] = [];

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "senpi-bundle-read-"));
	const packageRoot = join(
		scratch,
		"OmO.app",
		"Contents",
		"Resources",
		"omo-runtime",
		`${process.platform}-${process.arch}`,
		"node_modules",
		"@code-yeongyu",
		"senpi",
	);
	skillPath = join(dirname(packageRoot), "senpi-codemode", "src", "skill", "bun-1-4", "SKILL.md");
	await mkdir(packageRoot, { recursive: true });
	await mkdir(dirname(skillPath), { recursive: true });
	await writeFile(join(dirname(packageRoot), "senpi-codemode", "package.json"), '{"name":"bundled-codemode"}');
	await writeFile(skillPath, "bundled skill instructions\n");
	vi.stubEnv("SENPI_PACKAGE_DIR", packageRoot);
	approvals.length = 0;
});

afterEach(async () => {
	harness?.cleanup();
	harness = undefined;
	vi.unstubAllEnvs();
	await rm(scratch, { recursive: true, force: true });
});

async function openSession(preset: string): Promise<Harness> {
	harness = await createHarness({
		extensionFactories: [permissionSystemExtension],
		extensionFlagValues: new Map([["permission-preset", preset]]),
	});
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({
			select: async (title) => {
				approvals.push(title.split("\n")[0] ?? title);
				return "Deny";
			},
		}),
	});
	return harness;
}

describe("bundled resource reads through the session tool pipeline", () => {
	for (const preset of ["full-access", "workspace", "accept-edits", "read-only", "ask"]) {
		it(`reads a packaged skill without asking when the preset is ${preset}`, async () => {
			// Given a packaged runtime outside the user's project.
			const session = await openSession(preset);
			// When the agent reads a shipped skill through the real read tool.
			const result = await session.session.executeTool("read", { path: skillPath });
			// Then its instructions reach the agent without an approval card.
			expect(approvals).toEqual([]);
			expect(getMessageText(result)).toContain("bundled skill instructions");
		});
	}

	it("asks for external_directory when accept-edits reads an outside system file", async () => {
		// Given a command-asking session.
		const session = await openSession("accept-edits");
		// When the agent reads a user-supplied outside path.
		const result = session.session.executeTool("read", { path: "/etc/hosts" });
		// Then denial prevents the system file reaching the agent.
		await expect(result).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: external_directory"]);
	});

	it("asks before writing a bundled file when the preset is ask", async () => {
		// Given a shipped file and an ask-first session.
		const session = await openSession("ask");
		// When the agent attempts to overwrite that file.
		const result = session.session.executeTool("write", { path: skillPath, content: "overwritten" });
		// Then the approval is required and denial leaves the shipped file intact.
		await expect(result).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: edit"]);
		expect(await readFile(skillPath, "utf8")).toBe("bundled skill instructions\n");
	});

	it("asks for an outside write even when accept-edits allows project edits", async () => {
		// Given a bundled file outside a project-editing session.
		const session = await openSession("accept-edits");
		// When the agent attempts to overwrite the bundled instructions.
		const result = session.session.executeTool("write", { path: skillPath, content: "overwritten" });
		// Then it still needs outside-directory approval.
		await expect(result).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: external_directory"]);
		expect(await readFile(skillPath, "utf8")).toBe("bundled skill instructions\n");
	});

	it("does not interpret a relative user path as relative to an install root", async () => {
		// Given a relative outside file beside the project, not in the bundle.
		const session = await openSession("accept-edits");
		const outside = join(scratch, "relative-outside.txt");
		await writeFile(outside, "outside");
		// When the agent reads it relative to the project.
		const result = session.session.executeTool("read", { path: relative(session.tempDir, outside) });
		// Then only the project-relative resolved target determines permission.
		await expect(result).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: external_directory"]);
	});

	it("asks when a bundled symlink resolves to an outside file", async () => {
		// Given a symlink in the bundle that escapes its shipped root.
		const outside = join(scratch, "private.txt");
		await writeFile(outside, "private outside content");
		const link = join(dirname(skillPath), "outside.md");
		await symlink(outside, link);
		const session = await openSession("accept-edits");
		// When the agent reads the apparent bundled file.
		const result = session.session.executeTool("read", { path: link });
		// Then the resolved outside path still requires approval and remains private.
		await expect(result).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: external_directory"]);
	});
});
