import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EnvironmentError } from "./py-installer.ts";

/**
 * Every managed-root write goes through here: each component of `path` strictly below `root` that exists must be a
 * real file or directory, never a link, so a write can never land in what a planted link points at. `root` itself
 * may be a link (a user may relocate their whole artifacts directory); nothing below it may.
 */
export async function assertNoLinksBelow(root: string, path: string): Promise<void> {
	const below = relative(root, path);
	if (below.startsWith("..") || isAbsolute(below)) {
		throw new EnvironmentError("environment_install_failed", "refusing to write outside the managed environment");
	}
	let current = root;
	for (const part of below.split(sep).filter((segment) => segment !== "")) {
		current = join(current, part);
		const stats = await lstat(current).catch(missing);
		if (stats === undefined) return;
		if (stats.isSymbolicLink()) {
			throw new EnvironmentError(
				"environment_install_failed",
				`${relative(root, current)} is a link; refusing to write through it`,
			);
		}
	}
}

/** A copy filter: a link inside `tree` may point only inside `tree`, so a copied revision never reaches out. */
export async function assertLinkStaysInside(path: string, tree: string): Promise<boolean> {
	if (!(await lstat(path)).isSymbolicLink()) return true;
	const inside = relative(tree, resolve(dirname(path), await readlink(path)));
	if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return true;
	throw new EnvironmentError(
		"environment_install_failed",
		`${relative(tree, path)} links outside its revision; refusing to build on it`,
	);
}

function missing(error: unknown): undefined {
	if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
	throw error;
}
