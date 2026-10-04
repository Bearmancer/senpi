import type { EvalLanguage } from "./types.ts";

export type MagicCell =
	| { readonly kind: "pip"; readonly args: string }
	| { readonly kind: "environment"; readonly mode: "managed" | "project" };

const HOST_MAGICS = ["pip", "environment"] as const;
type HostMagic = (typeof HOST_MAGICS)[number];

export class MagicCellError extends Error {
	readonly name = "MagicCellError";
}

function joinContinuations(lines: readonly string[]): string[] {
	const joined: string[] = [];
	let pending: string | undefined;
	for (const line of lines) {
		const current = pending === undefined ? line : `${pending} ${line.trim()}`;
		if (current.trimEnd().endsWith("\\")) pending = current.trimEnd().slice(0, -1).trimEnd();
		else {
			joined.push(current);
			pending = undefined;
		}
	}
	if (pending !== undefined) joined.push(pending);
	return joined;
}

function hostMagicOf(line: string): HostMagic | undefined {
	const match = /^%([A-Za-z]+)(?:\s|$)/.exec(line.trim());
	const name = match?.[1];
	return HOST_MAGICS.find((magic) => magic === name);
}

/**
 * A Python cell whose first code line (blank and comment lines skipped) is `%pip ...` or `%environment ...`
 * runs on the host instead of the interpreter; a trailing backslash continues the line. Any other cell is
 * ordinary Python, so a `%pip` line later in the cell (say, inside a string) is left alone. A magic followed
 * by more code is refused, because the install must finish before the code that imports from it runs.
 */
export function parseMagicCell(language: EvalLanguage, code: string): MagicCell | undefined {
	if (language !== "py") return undefined;
	const lines = joinContinuations(code.split("\n")).filter(
		(line) => line.trim() !== "" && !line.trim().startsWith("#"),
	);
	const first = lines[0] ?? "";
	const magic = hostMagicOf(first);
	if (magic === undefined) return undefined;
	if (lines.length > 1)
		throw new MagicCellError(`put %${magic} on its own cell, then run the code that uses it in the next cell`);
	const args = first.trim().slice(`%${magic}`.length).trim();
	if (magic === "pip") return { kind: "pip", args };
	if (args === "managed" || args === "project") return { kind: "environment", mode: args };
	throw new MagicCellError("%environment takes one argument: managed or project");
}
