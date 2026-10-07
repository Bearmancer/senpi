import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { virtualEvalSchema } from "../src/bridges/eval-virtual-schemas.ts";

const SRC = join(import.meta.dirname, "..", "src");
const DOCUMENTED_CODE = /\b(environment_[a-z_]+|eval_isolate_[a-z_]+)\b/g;
const EMITTED_CODE = /"(environment_[a-z_]+|eval_isolate_[a-z_]+)"|(environment_[a-z_]+|eval_isolate_[a-z_]+): /g;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "vendor" ? [] : sourceFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

// A code counts as emitted when the source constructs an error with it, maps to it, or writes it as a message prefix;
// a name that only appears in a type union (declared, never raised) does not count.
function emittedCodes(): Set<string> {
	const codes = new Set<string>();
	for (const file of sourceFiles(SRC)) {
		if (file.endsWith("eval-environment-schemas.ts")) continue;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (/^\s*\|\s*"/.test(line)) continue;
			for (const match of line.matchAll(EMITTED_CODE)) codes.add(match[1] ?? match[2] ?? "");
		}
	}
	return codes;
}

function entry(name: string): { readonly name: string; readonly description: string; readonly parameters: unknown } {
	const found = virtualEvalSchema(name);
	if (found === undefined || !("name" in found)) throw new Error(`${name} is not a named schema entry`);
	return found;
}

describe("tool_schema('eval:*') virtual entries", () => {
	it("are exactly the five documented names", () => {
		for (const name of ["eval:wait", "eval:helpers", "eval:kernel-tools", "eval:environments", "eval:isolation"]) {
			expect(entry(name).name).toBe(name);
		}
		expect(virtualEvalSchema("eval:environment")).toBeUndefined();
		expect(virtualEvalSchema("eval:isolate")).toBeUndefined();
	});

	it("document the magics, %load and the environment modes", () => {
		const { description, parameters } = entry("eval:environments");
		for (const text of ["%pip install", "%bun add", "%npm add", "%environment managed | project", "%load", "8 MiB"]) {
			expect(description).toContain(text);
		}
		expect(Object.keys((parameters as { properties: object }).properties)).toEqual([
			"%pip",
			"%bun",
			"%npm",
			"%environment",
			"%load",
		]);
	});

	it("document isolate, its refusals and the sandbox limits", () => {
		const { description } = entry("eval:isolation");
		for (const text of ["isolate: true", "sandbox.enabled", "eval_isolate_invalid", "SENPI_CODEMODE_SANDBOX_MEMORY_MB"]) {
			expect(description).toContain(text);
		}
	});

	it("name only error codes the source actually emits", () => {
		const emitted = emittedCodes();
		for (const name of ["eval:environments", "eval:isolation"]) {
			const documented = [...entry(name).description.matchAll(DOCUMENTED_CODE)].map((match) => match[1]);
			expect(documented.length).toBeGreaterThan(0);
			expect(documented.filter((code) => code !== undefined && !emitted.has(code))).toEqual([]);
		}
	});
});
