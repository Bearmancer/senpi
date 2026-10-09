import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionResumeDelivery } from "../../../src/cli/schedule-delivery.ts";
import { runDueJobs } from "../../../src/cli/schedule-runner.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { createScheduledJob } from "../../../src/core/extensions/builtin/schedule/store.ts";
import { formatMissingSessionCwdError } from "../../../src/core/session-cwd.ts";
import { getDefaultSessionDir } from "../../../src/core/session-manager.ts";
import { type FakeModelServer, MOCK_MODEL, MOCK_PROVIDER, startFakeModelServer } from "../../helpers/rpc-fake-model.ts";
import { hermeticProviderEnv, writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";
import { createMovedLayout, type MovedLayout, writeSessionHeader } from "../moved-path-guard-fixtures.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

/**
 * code-yeongyu/senpi#2990: schedule delivery resumes a job's session with `senpi -p --session <file>` in the moved
 * working directory. The session header still names the old cwd; the real CLI must open the session where that cwd
 * lives now and run the turn, instead of exiting with "Stored session working directory does not exist".
 */

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const rootTsconfigPath = resolve(__dirname, "../../../../..", "tsconfig.json");
const SESSION_ID = "0199f0d4-2990-7000-8000-000000000002";
const PROMPT = "scheduled prompt unique-2990";
const CHILD_TIMEOUT_MS = 60_000;
const T0 = Date.parse("2026-10-07T12:00:00Z");

const layouts: MovedLayout[] = [];
const servers: FakeModelServer[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
	for (const child of children) child.kill("SIGKILL");
	children.clear();
	await Promise.all(servers.splice(0).map((server) => server.close()));
	while (layouts.length > 0) layouts.pop()?.cleanup();
});

async function movedSession(headerCwd?: (layout: MovedLayout) => string) {
	const layout = createMovedLayout();
	layouts.push(layout);
	const server = await startFakeModelServer();
	servers.push(server);
	const agentDir = join(layout.home, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeRpcModelsJson(agentDir, server.origin);
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultProvider: MOCK_PROVIDER, defaultModel: MOCK_MODEL })}\n`,
	);
	const sessionFile = join(layout.newSessions, "s.jsonl");
	writeSessionHeader(sessionFile, SESSION_ID, headerCwd ? headerCwd(layout) : layout.oldWorktree);
	const header = readFileSync(sessionFile, "utf8");
	const env: Record<string, string> = {
		...hermeticProviderEnv(),
		HOME: layout.home,
		USERPROFILE: layout.home,
		[ENV_AGENT_DIR]: agentDir,
		PI_OFFLINE: "1",
		TSX_TSCONFIG_PATH: rootTsconfigPath,
	};
	return { layout, server, sessionFile, header, env };
}

async function runCli(args: string[], cwd: string, env: Record<string, string>) {
	const child = spawn(process.execPath, [cliPath, ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
	// Bounded: a hang would otherwise block the suite on the failure this file guards.
	const timeout = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
	try {
		const code = await new Promise<number | null>((resolveExit, reject) => {
			child.on("error", reject);
			child.on("close", resolveExit);
		});
		return { code, output };
	} finally {
		clearTimeout(timeout);
		children.delete(child);
	}
}

function transcriptRoles(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { type: string; message?: { role?: string } })
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message?.role ?? "");
}

describe("issue #2990 headless resume of a session the OmO desktop moved", () => {
	it("`-p --session` from the moved worktree runs the turn and keeps the header", async () => {
		const { layout, server, sessionFile, header, env } = await movedSession();

		const result = await runCli(["-p", "--session", sessionFile, PROMPT], layout.newWorktree, env);

		expect(result.output).not.toContain("Stored session working directory does not exist");
		expect(result.code).toBe(0);
		expect(server.requests.map((request) => request.text).join("\n")).toContain(PROMPT);
		expect(readFileSync(sessionFile, "utf8").startsWith(header)).toBe(true);
		expect(transcriptRoles(sessionFile)).toEqual(["user", "assistant"]);
		expect(readdirSync(layout.oldRoot)).toEqual(["omo-desktop-moved.json"]);
	});

	// Review L3: an id found in another project's default session dir whose cwd moved here is this folder's session.
	it("`-p --session <id>` opens a session recorded under the old folder without the cross-project refusal", async () => {
		const { layout, server, env } = await movedSession();
		const sessionFile = join(getDefaultSessionDir(layout.oldWorktree, env[ENV_AGENT_DIR]), `${SESSION_ID}.jsonl`);
		writeSessionHeader(sessionFile, SESSION_ID, layout.oldWorktree);
		const header = readFileSync(sessionFile, "utf8");

		const result = await runCli(["-p", "--session", SESSION_ID, PROMPT], layout.newWorktree, env);

		expect(result.output).not.toContain(`--fork '${SESSION_ID}'`);
		expect(result.code).toBe(0);
		expect(server.requests.map((request) => request.text).join("\n")).toContain(PROMPT);
		expect(readFileSync(sessionFile, "utf8").startsWith(header)).toBe(true);
		expect(transcriptRoles(sessionFile)).toEqual(["user", "assistant"]);
	});

	it("a recorded cwd no breadcrumb lists still fails with the missing-cwd message", async () => {
		const gone = (layout: MovedLayout) => join(layout.oldRoot, "worktrees", "app", "never-moved");
		const { layout, server, sessionFile, header, env } = await movedSession(gone);

		const result = await runCli(["-p", "--session", sessionFile, PROMPT], layout.newWorktree, env);

		expect(result.code).toBe(1);
		expect(result.output).toContain(
			formatMissingSessionCwdError({ sessionFile, sessionCwd: gone(layout), fallbackCwd: layout.newWorktree }),
		);
		expect(server.requests).toEqual([]);
		expect(readFileSync(sessionFile, "utf8")).toBe(header);
	});

	it("schedule delivery fires a job written before the move against the moved session", async () => {
		const { layout, server, sessionFile, header, env } = await movedSession();
		const dir = join(layout.home, "schedule");
		await createScheduledJob(
			dir,
			{
				sessionId: SESSION_ID,
				sessionFile: join(layout.oldSessions, "s.jsonl"),
				cwd: layout.oldWorktree,
				prompt: PROMPT,
				dueAt: T0,
				everyMs: null,
			},
			T0 - 1,
		);
		const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
		Object.assign(process.env, env);
		try {
			const result = await runDueJobs({
				dir,
				now: () => T0 + 1,
				owner: { pid: process.pid, processStartedAtMs: 1_000 },
				runners: async () => [],
				deliver: sessionResumeDelivery({ command: process.execPath, args: [cliPath] }, CHILD_TIMEOUT_MS),
			});

			expect(result.events).toEqual([expect.objectContaining({ event: "fired", outcome: "delivered" })]);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		const failed = join(dir, "failed");
		expect(existsSync(failed) ? readdirSync(failed) : []).toEqual([]);
		expect(server.requests.map((request) => request.text).join("\n")).toContain(PROMPT);
		expect(readFileSync(sessionFile, "utf8").startsWith(header)).toBe(true);
		expect(transcriptRoles(sessionFile)).toEqual(["user", "assistant"]);
		expect(readdirSync(layout.oldRoot)).toEqual(["omo-desktop-moved.json"]);
	});
});
