import { lstatSync, readlinkSync } from "node:fs";
import * as path from "node:path";
import { normalizePath } from "../../../../utils/paths.ts";
import { isCredentialPath } from "./auto-credentials.ts";
import { expandHome } from "./external-dir.ts";

const MAX_SYMLINK_HOPS = 40;

/** Hidden project entries `auto` may touch: repository metadata and formatter/linter configs. */
const SAFE_HIDDEN_NAMES = new Set([
	".github",
	".gitignore",
	".gitattributes",
	".editorconfig",
	".nvmrc",
	".node-version",
	".prettierrc",
	".prettierignore",
	".eslintrc",
	".eslintignore",
	".stylelintrc",
	".markdownlint.json",
	".vscode",
]);

/**
 * The physical location of `absolute`, following each component in traversal order: a symlink is
 * replaced by its target before any later `..` applies, as the kernel does. A path that does not
 * exist yet resolves its deepest existing ancestor and keeps the remaining names, which must be
 * plain names. Returns undefined whenever the answer is not certain (a `..` after a missing
 * component, a dangling or looping link, an unreadable component).
 */
export function resolvePhysicalPath(absolute: string): string | undefined {
	const { root } = path.parse(absolute);
	const pending = absolute
		.slice(root.length)
		.split(path.sep)
		.filter((part) => part.length > 0);
	const resolved: string[] = [];
	let hops = 0;
	let missing = false;
	while (pending.length > 0) {
		const part = pending.shift() as string;
		if (part === ".") continue;
		if (part === "..") {
			if (missing) return undefined;
			resolved.pop();
			continue;
		}
		if (missing) {
			resolved.push(part);
			continue;
		}
		const candidate = path.join(root, ...resolved, part);
		let isLink: boolean;
		try {
			isLink = lstatSync(candidate).isSymbolicLink();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") return undefined;
			missing = true;
			resolved.push(part);
			continue;
		}
		if (!isLink) {
			resolved.push(part);
			continue;
		}
		hops += 1;
		if (hops > MAX_SYMLINK_HOPS) return undefined;
		let link: string;
		try {
			link = readlinkSync(candidate);
		} catch {
			return undefined;
		}
		if (path.isAbsolute(link)) resolved.length = 0;
		const linkRoot = path.isAbsolute(link) ? path.parse(link).root.length : 0;
		pending.unshift(
			...link
				.slice(linkRoot)
				.split(path.sep)
				.filter((segment) => segment.length > 0),
		);
	}
	return path.join(root, ...resolved);
}

/**
 * Every spelling a file tool may turn `raw` into, in the tool's own order: `@` stripped, Unicode
 * spaces normalized, `~`/`$HOME` expanded, then the quoted form `read` falls back to. A path the
 * tool would open must be among these, so `auto` checks all of them.
 */
export function toolPathSpellings(raw: string): string[] {
	const spellings = [normalizePath(raw, { normalizeUnicodeSpaces: true, stripAtPrefix: true })];
	const quoted = /^@?(["'])(.+)\1$/.exec(raw.trim());
	if (quoted?.[2] !== undefined) {
		spellings.push(normalizePath(quoted[2], { normalizeUnicodeSpaces: true, stripAtPrefix: true }));
	}
	return spellings.map((spelling) => expandHome(spelling));
}

const isInside = (target: string, root: string): boolean => {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * Whether `auto` may touch `target` without asking: it resolves physically inside the project
 * root, no component below the root is hidden (other than a short list of repository and
 * formatter files), and nothing along it is credential-shaped.
 */
export function isApprovableProjectPath(target: string, projectRoot: string): boolean {
	const root = resolvePhysicalPath(path.resolve(projectRoot));
	if (root === undefined) return false;
	const physical = resolvePhysicalPath(path.isAbsolute(target) ? target : path.join(root, target));
	if (physical === undefined || !isInside(physical, root)) return false;
	const below = path.relative(root, physical);
	if (below === "") return true;
	const segments = below.split(path.sep);
	if (segments.some((segment) => segment.startsWith(".") && !SAFE_HIDDEN_NAMES.has(segment))) return false;
	return !isCredentialPath(physical) && !isCredentialPath(target);
}

/**
 * The tool-path form of {@link isApprovableProjectPath}. Every spelling the tool may use must be
 * approvable twice over: as the tool's own string (`path.resolve`, which collapses `..` first) and
 * as written (traversal order, `..` after a symlink), so neither reading of `a/../b` can escape.
 */
export function isApprovableToolPath(raw: string, cwd: string): boolean {
	return toolPathSpellings(raw).every(
		(spelling) =>
			isApprovableProjectPath(path.resolve(cwd, spelling), cwd) &&
			isApprovableProjectPath(path.isAbsolute(spelling) ? spelling : `${cwd}${path.sep}${spelling}`, cwd),
	);
}
