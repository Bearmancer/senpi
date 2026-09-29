import {
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { RUNTIME_SNAPSHOT_MARKER, type RuntimeSnapshotMarker } from "./marker.ts";

export interface RuntimeManifest {
	readonly buildId: string;
	readonly externals: readonly string[];
}

export class RuntimeSnapshotLayoutError extends Error {
	readonly packageName: string;

	constructor(packageName: string) {
		super(`runtime snapshot resolves ${packageName} differently from the install`);
		this.packageName = packageName;
	}
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function occupied(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

function linkEntry(source: string, target: string): void {
	let isDirectory: boolean;
	try {
		isDirectory = statSync(source).isDirectory();
	} catch (error) {
		// A dangling link in the install stays unresolvable from the snapshot too.
		if (isMissing(error)) return;
		throw error;
	}
	// Windows file symlinks need a privilege; the files involved are small, so copy them.
	if (process.platform === "win32" && !isDirectory) {
		copyFileSync(source, target);
		return;
	}
	symlinkSync(source, target, isDirectory ? "junction" : "file");
}

function linkChildren(sourceDir: string, targetDir: string, skip: ReadonlySet<string>): void {
	for (const name of readdirSync(sourceDir)) {
		if (skip.has(name) || occupied(join(targetDir, name))) continue;
		linkEntry(join(sourceDir, name), join(targetDir, name));
	}
}

/** The node_modules directories Node's resolver walks from `dir`, nearest first. */
function moduleDirectoriesFrom(dir: string): string[] {
	const directories: string[] = [];
	for (let current = dir; ; current = dirname(current)) {
		if (basename(current) !== "node_modules") {
			const candidate = join(current, "node_modules");
			if (existsSync(candidate)) directories.push(candidate);
		}
		if (dirname(current) === current) return directories;
	}
}

/**
 * One node_modules that resolves every package name the way the install does: the union of the
 * install's resolution path, nearest directory first, so hoisted and nested layouts both hold.
 */
function linkModules(packageDir: string, target: string): void {
	mkdirSync(target, { recursive: true });
	for (const source of moduleDirectoriesFrom(packageDir)) {
		for (const name of readdirSync(source)) {
			if (name === ".bin") continue;
			const scoped = name.startsWith("@") && statSync(join(source, name)).isDirectory();
			if (!scoped) {
				if (!occupied(join(target, name))) linkEntry(join(source, name), join(target, name));
				continue;
			}
			mkdirSync(join(target, name), { recursive: true });
			linkChildren(join(source, name), join(target, name), new Set());
		}
	}
}

function packageRootFrom(dir: string, packageName: string): string | undefined {
	for (const modules of moduleDirectoriesFrom(dir)) {
		const root = join(modules, packageName);
		if (existsSync(join(root, "package.json"))) return realpathSync(root);
	}
	return undefined;
}

function verifyExternals(packageDir: string, snapshotBundleDir: string, externals: readonly string[]): void {
	for (const name of externals) {
		const expected = packageRootFrom(packageDir, name);
		if (expected !== undefined && packageRootFrom(snapshotBundleDir, name) !== expected) {
			throw new RuntimeSnapshotLayoutError(name);
		}
	}
}

/**
 * Builds `target` as a copy of the package that no reinstall can touch: `dist/bundle` and
 * `package.json` are copied, every other entry is linked back to the install. Built beside the
 * target and renamed into place, so a crash never leaves a half-built snapshot under its name.
 */
export function materializeRuntimeSnapshot(packageDir: string, target: string, manifest: RuntimeManifest): void {
	const staging = join(dirname(target), `.tmp-${basename(target)}-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	try {
		const snapshotBundleDir = join(staging, "dist", "bundle");
		mkdirSync(join(staging, "dist"), { recursive: true });
		cpSync(join(packageDir, "dist", "bundle"), snapshotBundleDir, { recursive: true });
		copyFileSync(join(packageDir, "package.json"), join(staging, "package.json"));
		linkChildren(packageDir, staging, new Set(["dist", "package.json", "node_modules"]));
		linkChildren(join(packageDir, "dist"), join(staging, "dist"), new Set(["bundle"]));
		linkModules(packageDir, join(staging, "node_modules"));
		verifyExternals(packageDir, join(snapshotBundleDir, "chunks"), manifest.externals);
		const marker: RuntimeSnapshotMarker = { buildId: manifest.buildId, installPackageDir: realpathSync(packageDir) };
		writeFileSync(join(staging, RUNTIME_SNAPSHOT_MARKER), `${JSON.stringify(marker)}\n`);
		rmSync(target, { recursive: true, force: true });
		renameSync(staging, target);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
}
