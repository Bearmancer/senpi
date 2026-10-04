import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EnvironmentError } from "./py-installer.ts";

/**
 * Refuses a staged revision that pip filled with an editable install, however it was requested (a `-e` in a
 * requirement or constraint file, an include, an environment marker). pip records every editable install
 * in the distribution's `direct_url.json` (PEP 610) as `dir_info.editable`, so the check reads the result
 * instead of re-parsing pip's input. A refused revision is never published.
 */
export async function assertNoEditableInstalls(staging: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(staging);
	} catch {
		return;
	}
	for (const entry of entries.filter((name) => name.endsWith(".dist-info"))) {
		let text: string;
		try {
			text = await readFile(join(staging, entry, "direct_url.json"), "utf8");
		} catch {
			continue;
		}
		if (isEditable(text)) {
			throw new EnvironmentError(
				"environment_install_failed",
				`${entry.replace(/\.dist-info$/u, "")} was installed as editable; editable requirements are not allowed, because packages must live in the session's environment root`,
			);
		}
	}
}

function isEditable(text: string): boolean {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null || !("dir_info" in value)) return false;
		const dirInfo = value.dir_info;
		return typeof dirInfo === "object" && dirInfo !== null && "editable" in dirInfo && dirInfo.editable === true;
	} catch {
		return false;
	}
}
