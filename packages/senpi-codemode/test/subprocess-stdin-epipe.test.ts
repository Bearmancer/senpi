import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const subprocessModulePath = fileURLToPath(new URL("../src/kernels/shared/subprocess-process.ts", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const posix = process.platform !== "win32";

type EpipeReport = { readonly errors: readonly string[]; readonly sendAfterExit: boolean };

// The child closes its stdin, says "ready" and stays alive, so the host's next frame write hits a pipe with no reader
// (EPIPE) without any race on the child's exit. A second process then exits before a frame is sent to it. An
// unhandled stream error would end the driver with a non-zero status before it writes its report (senpi#3016).
function driverSource(): string {
	return [
		'import { writeFile } from "node:fs/promises";',
		`import { SubprocessProcess, spawnSubprocess } from ${JSON.stringify(subprocessModulePath)};`,
		"const [reportPath] = process.argv.slice(2);",
		"const errors = [];",
		"let ready = () => {};",
		"const readyLine = new Promise((resolve) => { ready = resolve; });",
		"let reported = () => {};",
		"const errorReported = new Promise((resolve) => { reported = resolve; });",
		"const handlers = {",
		'  onLine: (_source, line) => { if (line.trim() === "ready") ready(); },',
		"  onStderr: () => {},",
		"  onExit: () => {},",
		"  onError: (_source, error) => { errors.push(String(error.code ?? error.message)); reported(); },",
		"};",
		'const closed = new SubprocessProcess(spawnSubprocess(undefined, { command: "sh", args: ["-c", "exec 0</dev/null; echo ready; sleep 30"] }), handlers);',
		"await readyLine;",
		'closed.send("x".repeat(256 * 1024) + "\\n");',
		"await Promise.race([errorReported, new Promise((resolve) => setTimeout(resolve, 5_000))]);",
		"await closed.terminate();",
		'const exited = new SubprocessProcess(spawnSubprocess(undefined, { command: "sh", args: ["-c", "exit 0"] }), handlers);',
		"await exited.terminate();",
		'const sendAfterExit = exited.send("frame\\n");',
		"await new Promise((resolve) => setImmediate(resolve));",
		'await writeFile(reportPath, JSON.stringify({ errors, sendAfterExit }), "utf8");',
	].join("\n");
}

describe.skipIf(!bunAvailable || !posix)(
	"subprocess kernel stdin write failures (senpi#3016)",
	{ timeout: 60_000 },
	() => {
		it("Given a kernel child that closed its stdin when a frame is sent then the EPIPE is reported once through onError and the host survives", async () => {
			// given
			const root = await mkdtemp(join(tmpdir(), "senpi-stdin-epipe-"));
			try {
				const driverPath = join(root, "driver.ts");
				const reportPath = join(root, "report.json");
				await writeFile(driverPath, driverSource(), "utf8");

				// when
				const run = spawnSync("bun", [driverPath, reportPath], { encoding: "utf8", cwd: root, timeout: 45_000 });

				// then
				expect(run.status, run.stderr).toBe(0);
				const report: EpipeReport = JSON.parse(await readFile(reportPath, "utf8"));
				expect(report.errors).toEqual(["EPIPE"]);
				expect(report.sendAfterExit).toBe(false);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	},
);
