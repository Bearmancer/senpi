// A host process that owns one process-mode kernel and never closes it: it prints the kernel child's pid, then waits
// for the test to end it (SIGKILL, or a plain exit when it is sent "exit"). With "busy", a cell that never yields is
// running when the host is ended.
import { existsSync, mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";

const kernel = new JavaScriptKernel({
	sessionId: `host-${process.pid}`,
	cwd: process.cwd(),
	parallelPoolWidth: 1,
	isolation: "process",
});
await kernel.run({ cellId: "host-cell", code: "globalThis.alive = true", timeoutMs: 20_000 });
if (process.argv.includes("busy")) {
	// The cell writes a marker and then spins; the host reports its child only once the marker exists.
	const dir = mkdtempSync(join(tmpdir(), "senpi-busy-host-"));
	const marker = join(dir, "spinning");
	const started = new Promise<void>((resolve) => {
		const watcher = watch(dir, () => {
			if (!existsSync(marker)) return;
			watcher.close();
			resolve();
		});
	});
	void kernel.run({
		cellId: "host-busy",
		code: `(await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, "1"); for (;;) {}`,
		timeoutMs: 600_000,
	});
	await started;
	rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(`child ${kernel.processPid}\n`);
process.stdin.on("data", (data) => {
	if (String(data).includes("exit")) process.exit(0);
});
