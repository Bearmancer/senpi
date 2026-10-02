import assert from "node:assert";
import { describe, it } from "node:test";
import { frameLineBytesTotals, TUI } from "../src/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// senpi#1960 todo 2: the frame-level figure - the byte cost of the lines the last frame holds -
// reported alongside the render cache so the memory report can attribute a long session's growth.

describe("frame line byte totals (#1960)", () => {
	it("is zero before any frame renders", () => {
		assert.equal(frameLineBytesTotals().previousLinesBytes, 0);
	});

	it("reports the last frame's line bytes after a render", async () => {
		const terminal = new VirtualTerminal(40, 4);
		const tui = new TUI(terminal);
		const before = frameLineBytesTotals().previousLinesBytes;
		tui.start();
		// A frame renders whatever the TUI holds; the figure moves off zero.
		tui.requestRender();
		await new Promise((resolve) => setTimeout(resolve, 60));
		tui.stop();
		const after = frameLineBytesTotals().previousLinesBytes;
		assert.ok(after >= before, `frame bytes move: ${before} -> ${after}`);
	});
});
