import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxCellExecutor } from "../../src/kernels/sandbox/sandbox-cell.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Given an isolated cell whose QuickJS runtime is missing", () => {
	it("When the cell runs, then it reports eval_isolate_unavailable without a host path and none of its code runs", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-isolate-unavailable-"));
		roots.push(root);
		const missing = join(root, "not-here", "quickjs.wasm");
		const calls: string[] = [];
		const executeTool = async (name: string): Promise<AgentToolResult<unknown>> => {
			calls.push(name);
			return { content: [{ type: "text", text: "ran" }], details: {} };
		};
		const run = sandboxCellExecutor('await tools.write({ path: "marker", content: "ran" }); print("executed");', {
			sandbox: { enabled: true, memoryMb: 64, timeoutSeconds: 30 },
			executeTool,
			toolNames: () => ["write"],
			wasmPath: missing,
		});
		const emitted: unknown[] = [];

		const outcome = await run({ signal: new AbortController().signal, emit: (message) => emitted.push(message) });

		expect(outcome).toMatchObject({ ok: false, error: { name: "SandboxUnavailableError" } });
		const message = outcome.ok ? "" : (outcome.error?.message ?? "");
		expect(message).toMatch(/^eval_isolate_unavailable: /);
		expect(message).not.toContain(root);
		expect(calls).toEqual([]);
		expect(emitted).toEqual([]);
	});
});
