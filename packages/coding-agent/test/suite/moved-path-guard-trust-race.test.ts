import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findMovedPath } from "../../src/core/extensions/builtin/moved-path-guard/resolve.ts";
import {
	breadcrumbBody,
	createMovedLayout,
	MOVED_WORKTREE,
	type MovedLayout,
	writeHomeMarker,
} from "./moved-path-guard-fixtures.ts";

// code-yeongyu/senpi#2898 third review L-a: the trust decision and the content come from the same opened file. A
// breadcrumb swapped (for a symlink, or rewritten past the size cap) right after the guard first touches it must never
// redirect paths to the swapped-in home.

const swap = vi.hoisted(() => ({ file: "", run: undefined as (() => void) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const afterFirstTouch =
		<A extends unknown[], R>(fn: (...args: A) => R) =>
		(...args: A): R => {
			const result = fn(...args);
			if (String(args[0]) === swap.file && swap.run) {
				const run = swap.run;
				swap.run = undefined;
				run();
			}
			return result;
		};
	return { ...actual, lstatSync: afterFirstTouch(actual.lstatSync), openSync: afterFirstTouch(actual.openSync) };
});

describe.runIf(process.platform !== "win32")("moved-path-guard trust on the opened file (#2898)", () => {
	const layouts: MovedLayout[] = [];

	afterEach(() => {
		swap.run = undefined;
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	function attackerSetup() {
		const layout = createMovedLayout();
		layouts.push(layout);
		const attackerHome = join(layout.home, "attacker-home");
		writeHomeMarker(attackerHome);
		swap.file = join(layout.oldRoot, "omo-desktop-moved.json");
		return { layout, attackerHome, attackerBody: JSON.stringify(breadcrumbBody(attackerHome, [MOVED_WORKTREE])) };
	}

	it("never follows a breadcrumb replaced by a symlink after the guard first touched it", () => {
		const { layout, attackerHome, attackerBody } = attackerSetup();
		const planted = join(layout.home, "planted.json");
		fs.writeFileSync(planted, attackerBody);
		swap.run = () => {
			fs.rmSync(swap.file);
			fs.symlinkSync(planted, swap.file);
		};

		const moved = findMovedPath(join(layout.oldWorktree, "a.ts"));

		expect(moved?.movedTo).not.toBe(attackerHome);
	});

	it("never believes a breadcrumb rewritten past the size cap after the guard first touched it", () => {
		const { layout, attackerHome, attackerBody } = attackerSetup();
		swap.run = () => fs.writeFileSync(swap.file, `${attackerBody.slice(0, -1)},"pad":"${"x".repeat(70 * 1024)}"}`);

		const moved = findMovedPath(join(layout.oldWorktree, "a.ts"));

		expect(moved?.movedTo).not.toBe(attackerHome);
	});
});
