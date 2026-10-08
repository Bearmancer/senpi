import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";

class ProcessExitError extends Error {
	readonly code: string | number | null | undefined;

	constructor(code: string | number | null | undefined) {
		super(`process.exit(${String(code)})`);
		this.code = code;
	}
}

const tempDirs: string[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];
const originalOpenaiApiKey = process.env.OPENAI_API_KEY;
const originalCwd = process.cwd();

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	if (originalOpenaiApiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalOpenaiApiKey;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function useTempAgentDir(): void {
	const dir = mkdtempSync(join(tmpdir(), "senpi-2937-"));
	tempDirs.push(dir);
	mkdirSync(join(dir, "agent"), { recursive: true });
	mkdirSync(join(dir, "project"), { recursive: true });
	process.env[ENV_AGENT_DIR] = join(dir, "agent");
	process.env.OPENAI_API_KEY = "fake-openai-key";
	process.chdir(join(dir, "project"));
}

/** stdout reports unflushed bytes until the test emits `drain`, as a pipe with a slow reader does. */
function slowStdout(): { readonly waitingForDrain: Promise<void>; drain(): void } {
	let pending = true;
	let markWaiting: () => void = () => {};
	const waitingForDrain = new Promise<void>((resolve) => {
		markWaiting = resolve;
	});
	vi.spyOn(process.stdout, "writableLength", "get").mockImplementation(() => (pending ? 1 : 0));
	const once = process.stdout.once.bind(process.stdout);
	vi.spyOn(process.stdout, "once").mockImplementation((event, listener) => {
		if (event === "drain") markWaiting();
		return once(event, listener);
	});
	return {
		waitingForDrain,
		drain: () => {
			pending = false;
			process.stdout.emit("drain");
		},
	};
}

async function runUntilExitOrDrainWait(args: string[]) {
	vi.resetModules();
	const { main } = await import("../../../src/main.ts");
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	const exits: Array<string | number | null | undefined> = [];
	let markExited: () => void = () => {};
	const exited = new Promise<void>((resolve) => {
		markExited = resolve;
	});
	vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
		exits.push(code);
		markExited();
		throw new ProcessExitError(code);
	});
	const stdout = slowStdout();
	const run = main(args).catch((error: unknown) => error);
	const first = await Promise.race([exited.then(() => "exited"), stdout.waitingForDrain.then(() => "waiting")]);
	return { first, exits, stdout, run };
}

describe("senpi#2937 print-then-exit paths wait for stdout to drain", () => {
	it.each([
		["--list-models", ["--list-models", "gpt-5.4"]],
		["--version", ["--version"]],
	])("%s does not exit while stdout still holds output", async (_label, args) => {
		// given a reader that has not taken the printed output yet
		useTempAgentDir();

		// when the command prints and finishes
		const { first, exits, stdout, run } = await runUntilExitOrDrainWait(args);

		// then it waits for stdout instead of exiting, and exits 0 once the reader caught up
		expect(first).toBe("waiting");
		expect(exits).toEqual([]);
		stdout.drain();
		expect(await run).toMatchObject({ code: 0 });
		expect(exits).toEqual([0]);
	});
});
