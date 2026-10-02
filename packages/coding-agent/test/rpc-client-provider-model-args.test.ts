import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeArgvRecorder(): { cliPath: string; argvFile: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-argv-"));
	tempDirs.push(dir);
	const argvFile = join(dir, "argv.json");
	const cliPath = join(dir, "child.mjs");
	writeFileSync(
		cliPath,
		`
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (!line.trim()) continue;
		const request = JSON.parse(line);
		process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { commands: [] } }) + "\\n");
	}
});
process.stdin.resume();
`,
	);
	return { cliPath, argvFile };
}

async function spawnedArgs(options: { provider?: string; model?: string }): Promise<string[]> {
	const { cliPath, argvFile } = writeArgvRecorder();
	const client = new RpcClient({ cliPath, ...options });
	await client.start();
	try {
		await client.getCommands();
		return JSON.parse(readFileSync(argvFile, "utf8")) as string[];
	} finally {
		await client.stop();
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient provider and model arguments", () => {
	test("forwards --provider together with --model", async () => {
		const args = await spawnedArgs({ provider: "anthropic", model: "claude-test" });

		expect(args).toEqual(["--mode", "rpc", "--provider", "anthropic", "--model", "claude-test"]);
	});

	test("starts the host on its default model when only a provider is given", async () => {
		const args = await spawnedArgs({ provider: "anthropic" });

		expect(args).toEqual(["--mode", "rpc"]);
	});

	test("forwards a model without a provider", async () => {
		const args = await spawnedArgs({ model: "anthropic/claude-test" });

		expect(args).toEqual(["--mode", "rpc", "--model", "anthropic/claude-test"]);
	});
});
