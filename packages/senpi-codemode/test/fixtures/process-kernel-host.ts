// A host process that owns one process-mode kernel and never closes it: it prints the kernel child's pid, then waits
// for the test to end it (SIGKILL, or a plain exit when it is sent "exit").
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";

const kernel = new JavaScriptKernel({
	sessionId: `host-${process.pid}`,
	cwd: process.cwd(),
	parallelPoolWidth: 1,
	isolation: "process",
});
await kernel.run({ cellId: "host-cell", code: "globalThis.alive = true", timeoutMs: 20_000 });
process.stdout.write(`child ${kernel.processPid}\n`);
process.stdin.on("data", (data) => {
	if (String(data).includes("exit")) process.exit(0);
});
