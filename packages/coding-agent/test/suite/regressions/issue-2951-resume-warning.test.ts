import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

it("keeps /resume successful and warns when only the holder lookup has a filesystem error", async () => {
	const root = await mkdtemp(join(tmpdir(), "held-resume-"));
	const file = join(root, "session.jsonl");
	const id = "29510000-0000-4000-8000-000000000011";
	try {
		await writeFile(
			file,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id,
				cwd: root,
				timestamp: new Date(0).toISOString(),
			})}\n`,
		);
		await mkdir(join(root, "session-holders"));
		await writeFile(join(root, "session-holders", id), "not a directory");
		const switchSession = vi.fn(async () => ({ cancelled: false }));
		const warning = vi.fn();
		const fatal = vi.fn(() => ({ cancelled: true }));
		// Exercise the real controller method without starting a physical terminal.
		const controller: object = Object.create(InteractiveMode.prototype);
		Object.defineProperties(controller, {
			sessionManager: { value: SessionManager.open(file) },
			runtimeHost: { value: { switchSession } },
			clearStatusIndicator: { value: () => {} },
			showStatus: { value: vi.fn() },
			showWarning: { value: warning },
			handleFatalRuntimeError: { value: fatal },
		});
		const resume: unknown = Reflect.get(InteractiveMode.prototype, "handleResumeSession");
		if (typeof resume !== "function") throw new Error("Resume controller unavailable");
		await expect(resume.call(controller, file)).resolves.toEqual({ cancelled: false });
		expect(switchSession).toHaveBeenCalledTimes(1);
		expect(warning).toHaveBeenCalledTimes(1);
		expect(fatal).not.toHaveBeenCalled();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
