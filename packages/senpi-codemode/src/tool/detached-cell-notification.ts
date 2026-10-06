import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EvalDetachedCellNotification, EvalDetachedCellSnapshot } from "./detached-cell-manager.ts";
import { interruptionStateNote, unknownInterruptionStateNote } from "./interrupt-note.ts";
import type { EvalKernelState, EvalMemoryDetails } from "./types.ts";

/** The model sees as much of a detached cell's output as it would of a foreground result (oh-my-pi keeps 8 KB). */
const NOTIFICATION_TEXT_BUDGET_BYTES = 8_000;

export function detachedNotificationSpillPath(artifactsDir: string | undefined, cellId: string): string | undefined {
	if (artifactsDir === undefined) return undefined;
	return join(artifactsDir, "local", `detached-eval-${safeCellId(cellId)}.log`);
}

export async function buildDetachedCellNotification(
	snapshot: EvalDetachedCellSnapshot,
	spillPath: string | undefined,
): Promise<EvalDetachedCellNotification> {
	const output = textContent(snapshot);
	const images = snapshot.result.content.filter((part) => part.type === "image");
	if (Buffer.byteLength(output, "utf8") <= NOTIFICATION_TEXT_BUDGET_BYTES)
		return { cellId: snapshot.cellId, content: notificationText(snapshot, output), images };
	// The agent read tool resolves plain paths only, so the marker carries the absolute spill path,
	// never the kernel-helper local:// scheme.
	const where = await spill(output, spillPath);
	return { cellId: snapshot.cellId, content: notificationText(snapshot, elideMiddle(output, where)), images };
}

async function spill(output: string, spillPath: string | undefined): Promise<string> {
	if (spillPath === undefined) return "no spill file (no artifacts directory)";
	try {
		await mkdir(dirname(spillPath), { recursive: true });
		await writeFile(spillPath, output, "utf8");
		return `full output: ${spillPath}`;
	} catch (error) {
		return `full output could not be spilled: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/** Keeps whole lines from the head and the tail inside the budget and says exactly what was dropped between them. */
function elideMiddle(output: string, where: string): string {
	const half = Math.floor(NOTIFICATION_TEXT_BUDGET_BYTES / 2);
	const lines = output.split("\n");
	const head: string[] = [];
	let headBytes = 0;
	while (head.length < lines.length && headBytes + Buffer.byteLength(lines[head.length], "utf8") + 1 <= half) {
		headBytes += Buffer.byteLength(lines[head.length], "utf8") + 1;
		head.push(lines[head.length]);
	}
	const tail: string[] = [];
	let tailBytes = 0;
	for (let index = lines.length - 1; index >= head.length; index--) {
		const bytes = Buffer.byteLength(lines[index], "utf8") + 1;
		if (tailBytes + bytes > half) break;
		tailBytes += bytes;
		tail.unshift(lines[index]);
	}
	const elidedLines = lines.length - head.length - tail.length;
	const elidedBytes = Math.max(0, Buffer.byteLength(output, "utf8") - headBytes - tailBytes);
	return [...head, `[… ${elidedLines} lines (${elidedBytes} bytes) elided; ${where} …]`, ...tail].join("\n");
}

function notificationText(cell: EvalDetachedCellSnapshot, output: string): string {
	return [
		`<system-reminder>Detached eval cell ${cell.cellId} (${cell.language}) ${outcomeOf(cell)}.`,
		output.length === 0 ? "(no output)" : output,
		`${stateNoteOf(cell)}</system-reminder>`,
	].join("\n");
}

function textContent(cell: EvalDetachedCellSnapshot): string {
	return (
		cell.result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n") || cell.outputTail
	);
}

function outcomeOf(cell: EvalDetachedCellSnapshot): string {
	if (cell.hardLimitSeconds !== undefined) return `was killed at the ${cell.hardLimitSeconds}s hard limit`;
	if (cell.runBudgetSeconds !== undefined)
		return `was killed after exhausting its ${cell.runBudgetSeconds}s run budget (own execution time; host tool calls excluded)`;
	if (cell.state === "completed") return "completed";
	if (cell.state === "cancelled") return "cancelled";
	return "failed";
}

function stateNoteOf(cell: EvalDetachedCellSnapshot): string {
	if (cell.state !== "cancelled") {
		const kernelState = cell.result.details?.kernelState;
		return kernelState === undefined ? memoryStateNote(cell.result.details?.memory) : KERNEL_STATE_NOTES[kernelState];
	}
	const note = interruptionStateNote(cell.language, cell.stateRetained) ?? unknownInterruptionStateNote(cell.language);
	return cell.interruptNote === undefined ? note : `${note} ${cell.interruptNote.trim()}`;
}

/** A kernel death decides what survived, whatever the memory report says. */
const KERNEL_STATE_NOTES: Readonly<Record<EvalKernelState, string>> = {
	lost: "The kernel died while this cell ran - every global is lost; the next eval cell runs on a fresh kernel.",
	restarted:
		"The kernel was restarted before this cell ran - globals from earlier cells are gone; this cell's variables are available to the next eval cell.",
	"not-run": "This cell never ran and changed no kernel state.",
};

export function memoryStateNote(memory: EvalMemoryDetails | undefined): string {
	if (memory?.overCeiling === true)
		return "Kernel memory is over its ceiling - the kernel restarts before the next eval cell and every global is lost.";
	if (memory?.recycled === true)
		return "The kernel was restarted before this cell ran - globals from earlier cells are gone; this cell's variables are available to the next eval cell.";
	return "Kernel state updated - variables are available to the next eval cell.";
}

function safeCellId(cellId: string): string {
	return cellId.replace(/[^a-zA-Z0-9_-]/gu, "_");
}
