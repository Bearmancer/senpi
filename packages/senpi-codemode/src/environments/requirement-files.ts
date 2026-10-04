import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EnvironmentError } from "./py-installer.ts";

const REMOTE = /^[a-z][a-z0-9+.-]*:\/\//iu;
const EDITABLE = /^(?:-e|--editable)(?:[=\s]|$)|^-e\S/u;
const NESTED = /^(?:--requirement|--constraint|-r|-c)(?:=|\s+)?(\S.*)$/u;

/**
 * pip reads `-e <path>` from inside requirement and constraint files too, which would bring back the editable
 * install the command line refuses and load code from outside the environment. Every file named on the
 * command line is read, with the files it includes, and an editable line or a remote file is refused before
 * pip starts. A file that can't be read is left for pip to report.
 */
export async function assertNoEditableRequirements(args: readonly string[], cwd: string): Promise<void> {
	const seen = new Set<string>();
	for (const arg of args) {
		const file = /^--(?:requirement|constraint)=(.+)$/u.exec(arg)?.[1];
		if (file !== undefined) await scan(file, cwd, seen);
	}
}

async function scan(file: string, from: string, seen: Set<string>): Promise<void> {
	if (REMOTE.test(file)) {
		throw new EnvironmentError(
			"environment_install_failed",
			`${file}: requirement files must be local, so %pip can check them before installing`,
		);
	}
	const path = resolve(from, file);
	if (seen.has(path)) return;
	seen.add(path);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return;
	}
	for (const line of logicalLines(text)) {
		if (EDITABLE.test(line)) {
			throw new EnvironmentError(
				"environment_install_failed",
				`${file}: editable requirements (${line}) are not allowed; packages always install into the session's environment root`,
			);
		}
		const nested = NESTED.exec(line)?.[1];
		if (nested !== undefined) await scan(nested.trim(), dirname(path), seen);
	}
}

/** pip's line handling: a trailing backslash joins the next line, and `#` at the start or after whitespace starts a comment. */
function logicalLines(text: string): string[] {
	return text
		.replace(/\\\r?\n/gu, " ")
		.split(/\r?\n/u)
		.map((line) => line.replace(/(?:^|\s)#.*$/u, "").trim())
		.filter((line) => line !== "");
}
