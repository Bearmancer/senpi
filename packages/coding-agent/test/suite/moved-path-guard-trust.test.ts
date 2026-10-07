import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../src/core/agent-session-runtime.ts";
import { findMovedPath, resolveMovedPath } from "../../src/core/extensions/builtin/moved-path-guard/resolve.ts";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import {
	breadcrumbBody,
	createMovedLayout,
	MOVED_SESSIONS,
	MOVED_WORKTREE,
	type MovedLayout,
	writeBreadcrumb,
	writeHomeMarker,
} from "./moved-path-guard-fixtures.ts";

// code-yeongyu/senpi#2898 review H1: a breadcrumb is trusted only when it points at a real, normalized desktop
// home outside itself that holds the desktop's ownership marker with the breadcrumb's homeId.

describe("moved-path-guard breadcrumb trust (#2898)", () => {
	const layouts: MovedLayout[] = [];

	afterEach(() => {
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	function layout(options: Parameters<typeof createMovedLayout>[0] = {}): MovedLayout {
		const created = createMovedLayout(options);
		layouts.push(created);
		return created;
	}

	it("follows a breadcrumb whose new home carries the desktop marker with the same homeId", () => {
		const moved = layout();

		expect(resolveMovedPath(join(moved.oldWorktree, "a.ts"))).toBe(join(moved.newWorktree, "a.ts"));
	});

	it.each([
		["holds no desktop marker", "missing"],
		["belongs to another desktop home", "other-home"],
	] as const)("ignores a breadcrumb whose movedTo %s", (_label, marker) => {
		const moved = layout({ marker });

		expect(findMovedPath(join(moved.oldWorktree, "a.ts"))).toBeUndefined();
	});

	it("ignores a breadcrumb planted in a repository that points anywhere else", () => {
		const moved = layout();
		const repo = join(moved.home, "repo");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeBreadcrumb(repo, { ...breadcrumbBody("/etc/somewhere", ["src"]) });

		expect(findMovedPath(join(repo, "src", "x"))).toBeUndefined();
	});

	it.each([
		["a win32-shaped value on this host", "C:\\x"],
		["a path that climbs with ..", "/a/../../../tmp/zz"],
		["a trailing separator", "/a/b/"],
	])("ignores a movedTo with %s", (_label, movedTo) => {
		const moved = layout();
		writeBreadcrumb(moved.oldRoot, breadcrumbBody(movedTo, [MOVED_WORKTREE]));

		expect(findMovedPath(join(moved.oldWorktree, "a.ts"))).toBeUndefined();
	});

	it("ignores a movedTo equal to or inside the breadcrumb's own folder", () => {
		const moved = layout();
		const inside = join(moved.oldRoot, "nested-home");
		writeHomeMarker(inside);
		writeHomeMarker(moved.oldRoot);

		for (const movedTo of [moved.oldRoot, inside]) {
			writeBreadcrumb(moved.oldRoot, breadcrumbBody(movedTo, [MOVED_SESSIONS]));
			expect(findMovedPath(join(moved.oldSessions, "s.jsonl"))).toBeUndefined();
		}
	});

	// Review L5: an ignored breadcrumb is recorded in the debug log, never printed into the terminal a TUI owns.
	it("reports an ignored breadcrumb without writing to the terminal", () => {
		const moved = layout({ schemaVersion: 2 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(findMovedPath(join(moved.oldWorktree, "a.ts"))).toBeUndefined();
			expect(warn).not.toHaveBeenCalled();
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			stderr.mockRestore();
		}
	});

	it("never hands open_session a relative path from an untrusted breadcrumb", async () => {
		const moved = layout();
		writeBreadcrumb(moved.oldRoot, breadcrumbBody("C:\\x", [MOVED_WORKTREE]));
		const cwds: string[] = [];
		const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
			new ProjectTrustStore(options.agentDir).set(options.cwd, true);
			cwds.push(options.cwd);
			return {
				session: {
					sessionManager: options.sessionManager,
					agentDir: options.agentDir,
					extensionRunner: { hasHandlers: () => false, emit: async () => {} },
					abort: async () => {},
					abortBash: () => {},
					waitForIdle: async () => {},
					dispose: () => {},
				},
				services: { cwd: options.cwd, agentDir: options.agentDir },
				diagnostics: [],
			} as unknown as CreateAgentSessionRuntimeResult;
		};
		mkdirSync(moved.oldWorktree, { recursive: true });
		const registry = new RpcSessionRegistry({ agentDir: moved.home, createRuntime });

		const opened = await registry.openSession({ cwd: moved.oldWorktree });

		expect(cwds.every((cwd) => isAbsolute(cwd))).toBe(true);
		await registry.close(opened.sessionId);
	});
});
