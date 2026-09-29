import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FakeInstall {
	readonly root: string;
	readonly packageDir: string;
	readonly entryPath: string;
	readonly agentDir: string;
	reinstall(build: string): void;
	cleanup(): void;
}

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function writePackage(packageDir: string, build: string): void {
	write(join(packageDir, "package.json"), JSON.stringify({ name: "@code-yeongyu/senpi", version: build }));
	write(join(packageDir, "dist/bundle/cli.js"), `import("./chunks/provider-${build}.js");\n`);
	write(join(packageDir, `dist/bundle/chunks/provider-${build}.js`), `export const build = "${build}";\n`);
	write(
		join(packageDir, "dist/bundle/runtime-manifest.json"),
		JSON.stringify({ buildId: build, externals: ["hoisted-ext", "nested-dep", "absent-optional"] }),
	);
	write(join(packageDir, "dist/modes/interactive/theme/dark.json"), "{}\n");
	write(join(packageDir, "docs/index.md"), `# ${build}\n`);
	write(join(packageDir, "dist/core/extensions/builtin/websearch.js"), "export default () => {};\n");
	write(join(packageDir, "node_modules/nested-dep/package.json"), JSON.stringify({ name: "nested-dep" }));
}

/**
 * A global prefix laid out like `bun install -g`: the package under a scope, one dependency nested
 * inside it and one hoisted beside it, plus an agent directory that holds the runtime snapshots.
 */
export function createFakeInstall(build = "build-a"): FakeInstall {
	const root = mkdtempSync(join(tmpdir(), "senpi-runtime-snapshot-"));
	const packageDir = join(root, "global/node_modules/@code-yeongyu/senpi");
	write(join(root, "global/node_modules/hoisted-ext/package.json"), JSON.stringify({ name: "hoisted-ext" }));
	writePackage(packageDir, build);
	return {
		root,
		packageDir,
		entryPath: join(packageDir, "dist/bundle/cli.js"),
		agentDir: join(root, "agent"),
		reinstall(next) {
			rmSync(packageDir, { recursive: true, force: true });
			writePackage(packageDir, next);
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
