import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { hashServerKey, hashServerUrl } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";

const execFileAsync = promisify(execFile);
const workerPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "legacy-migration-worker.ts");

const SERVER_URL = "https://race-migration.example";
const LEGACY_RT = "legacy-rotating-refresh-token";

function writeLegacy(agentDir: string): void {
	const dir = join(agentDir, "mcp-auth", hashServerUrl(SERVER_URL));
	mkdirSync(dir, { mode: 0o700, recursive: true });
	const file = join(dir, "tokens.json");
	writeFileSync(
		file,
		`${JSON.stringify({ accessToken: "legacy-at", refreshToken: LEGACY_RT, resource: SERVER_URL })}\n`,
		{
			mode: 0o600,
		},
	);
	chmodSync(file, 0o600);
}

function tokensAt(agentDir: string, serverName: string): { refreshToken?: string } | undefined {
	const file = join(agentDir, "mcp-auth", hashServerKey(serverName, SERVER_URL), "tokens.json");
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as { refreshToken?: string };
	} catch {
		return undefined;
	}
}

describe("mcp token store legacy migration lock", () => {
	let agentDir = "";
	afterEach(() => {
		rmSync(agentDir, { force: true, recursive: true });
	});

	it("lets only one of two concurrent readers claim the same URL-keyed legacy grant", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "mcp-migrate-lock-"));
		writeLegacy(agentDir);

		const run = async (serverName: string): Promise<{ serverName: string; refresh: string | null }> => {
			const { stdout } = await execFileAsync(process.execPath, [workerPath, agentDir, serverName, SERVER_URL], {
				timeout: 20_000,
			});
			return JSON.parse(stdout.trim()) as { serverName: string; refresh: string | null };
		};

		const [work, personal] = await Promise.all([run("work"), run("personal")]);

		const adopted = [work, personal].filter((r) => r.refresh === LEGACY_RT);
		expect(adopted.length).toBe(1);

		const onDisk = [tokensAt(agentDir, "work"), tokensAt(agentDir, "personal")].filter(
			(t) => t?.refreshToken === LEGACY_RT,
		);
		expect(onDisk.length).toBe(1);
	});
});
