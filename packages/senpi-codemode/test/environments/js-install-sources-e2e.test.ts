import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readActiveRevision } from "../../src/environments/revision-store.ts";
import { hasCommand, packFixture, session, textOf } from "./js-magic-session.ts";

const probeSource = 'export const probe = () => "ok";\n';

async function packageDir(parent: string, name: string, source: string): Promise<string> {
	const dir = join(parent, `${name}-dir`);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "package.json"),
		JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }),
	);
	await writeFile(join(dir, "index.js"), source);
	return dir;
}

/** Every file below `dir` with its contents, links reported as such, so a write through any link shows up. */
function tree(dir: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (current: string) => {
		for (const entry of readdirSync(current)) {
			const path = join(current, entry);
			const stats = lstatSync(path);
			if (stats.isSymbolicLink()) files[relative(dir, path)] = "<link>";
			else if (stats.isDirectory()) walk(path);
			else files[relative(dir, path)] = readFileSync(path, "utf8");
		}
	};
	walk(dir);
	return files;
}

function activeBase(root: string): string {
	return join(root, "artifacts", "environments", "js", "test");
}

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))("Given a package installed from a local directory", () => {
	it.each([["npm"], ["bun"]] as const)(
		"When %s installs from a directory and then installs another package, then both import and the source directory is untouched",
		async (installer) => {
			const { fixtures, run } = await session(installer);
			const source = await packageDir(fixtures, "senpi-dir-probe", 'export const fromDir = () => "dir";\n');
			const tarball = await packFixture(fixtures, "senpi-after-dir", "1.0.0", probeSource);
			const before = tree(source);

			const first = await run(`%${installer} add ${source}`);
			const second = await run(`%${installer} add ${tarball}`);
			const imported = await run(
				'const { fromDir } = await import("senpi-dir-probe");\nconst { probe } = await import("senpi-after-dir");\nfromDir() + " " + probe()',
			);

			expect(textOf(first)).toContain(`added senpi-dir-probe with ${installer}`);
			expect(second.details).not.toHaveProperty("isError", true);
			expect(textOf(imported)).toContain("dir ok");
			expect(tree(source)).toEqual(before);
		},
		240_000,
	);

	it("When the directory's package is replaced by a tarball of the same name, then the import gets the tarball and the directory is untouched", async () => {
		const { fixtures, run } = await session("npm");
		const source = await packageDir(fixtures, "senpi-dir-swap", 'export const which = () => "dir";\n');
		const tarball = await packFixture(fixtures, "senpi-dir-swap", "2.0.0", 'export const which = () => "tarball";\n');
		const before = tree(source);

		await run(`%npm add ${source}`);
		const replaced = await run(`%npm add ${tarball}`);
		const imported = await run('const { which } = await import("senpi-dir-swap");\nwhich()');

		expect(replaced.details).not.toHaveProperty("isError", true);
		expect(textOf(imported).trim()).toBe('"tarball"');
		expect(tree(source)).toEqual(before);
	}, 240_000);

	it("When a package's link points outside the revision at a directory no install recorded, then the next install is refused and that directory is untouched", async () => {
		const { root, fixtures, run } = await session("npm");
		const source = await packageDir(fixtures, "senpi-dir-recorded", probeSource);
		const unrecorded = await packageDir(fixtures, "senpi-dir-unrecorded", probeSource);
		const tarball = await packFixture(fixtures, "senpi-dir-next", "1.0.0", probeSource);
		await run(`%npm add ${source}`);
		const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
		await symlink(unrecorded, join(revision, "node_modules", "senpi-dir-unrecorded"));
		const before = tree(unrecorded);

		const next = await run(`%npm add ${tarball}`);

		expect(next.details).toHaveProperty("isError", true);
		expect(textOf(next)).toContain("node_modules/senpi-dir-unrecorded links outside its revision");
		expect(tree(unrecorded)).toEqual(before);
	}, 240_000);

	it("When one package's link points at the directory recorded for another package, then the next install is refused", async () => {
		const { root, fixtures, run } = await session("npm");
		const source = await packageDir(fixtures, "senpi-dir-owner", probeSource);
		const tarball = await packFixture(fixtures, "senpi-dir-next", "1.0.0", probeSource);
		await run(`%npm add ${source}`);
		const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
		await symlink(source, join(revision, "node_modules", "senpi-dir-borrower"));

		const next = await run(`%npm add ${tarball}`);

		expect(next.details).toHaveProperty("isError", true);
		expect(textOf(next)).toContain("node_modules/senpi-dir-borrower links outside its revision");
	}, 240_000);

	it("When an installer path of the revision links at a recorded source directory, then the next install is refused and the source is untouched", async () => {
		const { root, fixtures, run } = await session("npm");
		const source = await packageDir(fixtures, "senpi-dir-target", probeSource);
		const tarball = await packFixture(fixtures, "senpi-dir-next", "1.0.0", probeSource);
		await run(`%npm add ${source}`);
		const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
		await rm(join(revision, "package-lock.json"));
		await symlink(join(source, "package.json"), join(revision, "package-lock.json"));
		const before = tree(source);

		const next = await run(`%npm add ${tarball}`);

		expect(next.details).toHaveProperty("isError", true);
		expect(textOf(next)).toContain("package-lock.json links outside its revision");
		expect(tree(source)).toEqual(before);
	}, 240_000);

	it("When the active revision no longer records the directory an earlier revision installed from, then its link is refused", async () => {
		const { root, fixtures, run } = await session("npm");
		const source = await packageDir(fixtures, "senpi-dir-forgotten", probeSource);
		const tarball = await packFixture(fixtures, "senpi-dir-next", "1.0.0", probeSource);
		const later = await packFixture(fixtures, "senpi-dir-later", "1.0.0", probeSource);
		await run(`%npm add ${source}`);
		await run(`%npm add ${tarball}`);
		const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
		const manifestPath = join(revision, "package.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dependencies: Record<string, string> };
		delete manifest.dependencies["senpi-dir-forgotten"];
		await writeFile(manifestPath, JSON.stringify(manifest));

		const next = await run(`%npm add ${later}`);

		expect(textOf(next)).toContain("node_modules/senpi-dir-forgotten links outside its revision");
		expect((await readActiveRevision(activeBase(root)))?.dir).toBe(revision);
	}, 240_000);
});

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))("Given a managed JavaScript revision", () => {
	it("When the revision's node_modules is a relative link to a directory inside it, then the next install is refused and that directory is untouched", async () => {
		const { root, fixtures, run } = await session("npm");
		const first = await packFixture(fixtures, "senpi-inner-first", "1.0.0", probeSource);
		const second = await packFixture(fixtures, "senpi-inner-second", "1.0.0", probeSource);
		await run(`%npm add ${first}`);
		const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
		await mkdir(join(revision, "kept"));
		await writeFile(join(revision, "kept", "marker"), "unchanged\n");
		await rm(join(revision, "node_modules"), { recursive: true });
		await symlink("kept", join(revision, "node_modules"));

		const next = await run(`%npm add ${second}`);

		expect(next.details).toHaveProperty("isError", true);
		expect(textOf(next)).toContain("node_modules is a link; refusing to write through it");
		expect(tree(join(revision, "kept"))).toEqual({ marker: "unchanged\n" });
	}, 240_000);

	it("When an install runs under umask 022, then every managed directory and the revision are private to the user", async () => {
		const previous = process.umask(0o022);
		try {
			const { root, fixtures, run } = await session("npm");
			const tarball = await packFixture(fixtures, "senpi-private", "1.0.0", probeSource);
			await run(`%npm add ${tarball}`);
			const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
			const levels = [
				join(root, "artifacts"),
				join(root, "artifacts", "environments"),
				join(root, "artifacts", "environments", "js"),
				activeBase(root),
				revision,
			];

			expect(levels.map((dir) => [relative(root, dir), (statSync(dir).mode & 0o777).toString(8)])).toEqual(
				levels.map((dir) => [relative(root, dir), "700"]),
			);
		} finally {
			process.umask(previous);
		}
	}, 240_000);

	it("When npm is told to install globally by its config, then the install still lands in the revision and imports", async () => {
		const { fixtures, run } = await session("npm", undefined, {
			...process.env,
			npm_config_global: "true",
			npm_config_location: "global",
		});
		const tarball = await packFixture(fixtures, "senpi-not-global", "1.0.0", probeSource);

		const install = await run(`%npm add ${tarball}`);
		const imported = await run('const { probe } = await import("senpi-not-global");\nprobe()');

		expect(textOf(install)).toContain("added senpi-not-global with npm");
		expect(textOf(imported).trim()).toBe('"ok"');
	}, 240_000);
});
