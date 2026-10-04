import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { EnvironmentError } from "./py-installer.ts";

/**
 * Refuses a staged revision that loads code from outside itself, however pip was asked for it. It catches
 * a PEP 660 editable install (`direct_url.json` with `dir_info.editable`), a legacy `setup.py develop`
 * (an `.egg-link`), a `.pth` line or symlink that resolves outside the revision. A refused revision is
 * never published.
 */
export async function assertNoEditableInstalls(staging: string): Promise<void> {
	const root = await realpath(staging).catch(() => resolve(staging));
	let entries: string[];
	try {
		entries = await readdir(staging);
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(staging, entry);
		if (entry.endsWith(".egg-link"))
			refuse(entry.replace(/\.egg-link$/u, ""), "a legacy editable install (.egg-link)");
		if (
			entry.endsWith(".dist-info") &&
			isEditable(await readFile(join(path, "direct_url.json"), "utf8").catch(() => ""))
		) {
			refuse(entry.replace(/\.dist-info$/u, ""), "an editable install");
		}
		if (entry.endsWith(".pth")) {
			for (const line of (await readFile(path, "utf8").catch(() => "")).split(/\r?\n/u)) {
				const text = line.trim();
				if (text === "" || text.startsWith("#") || text.startsWith("import ")) continue;
				if (!(await inside(root, resolve(staging, text))))
					refuse(entry, `a path outside the environment (${text})`);
			}
		}
		if ((await lstat(path)).isSymbolicLink() && !(await inside(root, path))) {
			refuse(entry, "a link that points outside the environment");
		}
	}
}

async function inside(root: string, path: string): Promise<boolean> {
	const real = await realpath(path).catch(() => resolve(path));
	const rel = relative(root, real);
	return (
		rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep) && !/^[A-Za-z]:/u.test(rel))
	);
}

function refuse(name: string, what: string): never {
	throw new EnvironmentError(
		"environment_install_failed",
		`${name} was installed as ${what}; packages must live in the session's environment root, so editable and linked installs are not allowed`,
	);
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
