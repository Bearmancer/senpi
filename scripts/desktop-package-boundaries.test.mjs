import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findPackageDirectories } from "./package-workspaces.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const PROTOCOL = "@code-yeongyu/senpi-desktop-protocol";
const PRELUDE = "@code-yeongyu/senpi-desktop-prelude";
const ENGINE = "@code-yeongyu/senpi-desktop-engine";
const SERVICE = "@code-yeongyu/senpi-desktop-service";
const TOOL = "@code-yeongyu/senpi-desktop-tool";
const DESKTOP_PACKAGES = new Map([
	[PROTOCOL, "packages/desktop-protocol"],
	[PRELUDE, "packages/desktop-prelude"],
	[ENGINE, "packages/desktop-engine"],
	[SERVICE, "packages/desktop-service"],
	[TOOL, "packages/desktop-tool"],
]);
const CODING_AGENT = { name: "@code-yeongyu/senpi", directory: "packages/coding-agent" };
const CODEMODE = { name: "@code-yeongyu/senpi-codemode", directory: "packages/senpi-codemode" };
// Desktop package -> the desktop packages it may import. Anything else under the desktop scope is a violation.
const ALLOWED_DESKTOP_EDGES = new Map([
	[PROTOCOL, []],
	[PRELUDE, []],
	[ENGINE, [PROTOCOL]],
	[SERVICE, [PROTOCOL, ENGINE, PRELUDE]],
	[TOOL, [PROTOCOL, ENGINE, PRELUDE, SERVICE]],
]);
const AGENT_LAYER_PACKAGES = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"];
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const SPECIFIER_PATTERNS = [
	/\b(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/g,
	/\bimport\s*["']([^"']+)["']/g,
	/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
	/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function packageNameOf(specifier) {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function listSourceFiles(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return listSourceFiles(path);
		return SOURCE_FILE.test(entry.name) ? [path] : [];
	});
}

/** Every workspace-visible edge a package declares: manifest dependencies plus src/ import specifiers. */
function collectEdges(directory) {
	const manifest = JSON.parse(readFileSync(join(repoRoot, directory, "package.json"), "utf8"));
	const manifestEdges = DEPENDENCY_SECTIONS.flatMap((section) =>
		Object.keys(manifest[section] ?? {}).map((target) => ({ from: `${directory}/package.json ${section}`, target })),
	);
	const sourceEdges = listSourceFiles(join(repoRoot, directory, "src")).flatMap((file) => {
		const source = readFileSync(file, "utf8");
		return SPECIFIER_PATTERNS.flatMap((pattern) =>
			[...source.matchAll(pattern)].map((match) => ({
				from: relative(repoRoot, file).replaceAll("\\", "/"),
				target: packageNameOf(match[1]),
			})),
		);
	});
	return [...manifestEdges, ...sourceEdges];
}

function describeEdges(edges) {
	return edges.map(({ from, target }) => `${from} -> ${target}`);
}

describe("desktop package boundaries", () => {
	it("keeps senpi-codemode free of every desktop package", () => {
		// Given: codemode ships as a source sidecar whose only host is the senpi extension API.
		const edges = collectEdges(CODEMODE.directory);

		// When
		const violations = edges.filter(({ target }) => DESKTOP_PACKAGES.has(target));

		// Then
		assert.deepEqual(describeEdges(violations), []);
	});

	it("lets coding-agent reach desktop behavior only through the tool and service packages", () => {
		// Given
		const edges = collectEdges(CODING_AGENT.directory);

		// When
		const violations = edges.filter(({ target }) => DESKTOP_PACKAGES.has(target) && ![TOOL, SERVICE].includes(target));

		// Then
		assert.deepEqual(describeEdges(violations), []);
	});

	it("keeps each desktop package on its allowed desktop edges", () => {
		// Given
		const edgesByPackage = [...DESKTOP_PACKAGES].map(([name, directory]) => ({ name, edges: collectEdges(directory) }));

		// When
		const violations = edgesByPackage.flatMap(({ name, edges }) =>
			edges.filter(
				({ target }) =>
					target !== name && DESKTOP_PACKAGES.has(target) && !ALLOWED_DESKTOP_EDGES.get(name).includes(target),
			),
		);

		// Then
		assert.deepEqual(describeEdges(violations), []);
	});

	it("keeps the agent, ai, and tui packages out of every desktop package", () => {
		// Given
		const edges = [...DESKTOP_PACKAGES.values()].flatMap(collectEdges);

		// When
		const violations = edges.filter(({ target }) => AGENT_LAYER_PACKAGES.includes(target));

		// Then
		assert.deepEqual(describeEdges(violations), []);
	});

	it("keeps protocol and prelude free of any workspace import", () => {
		// Given
		const workspaceNames = new Set(
			findPackageDirectories(join(repoRoot, "packages")).map(
				(directory) => JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name,
			),
		);
		const edges = [DESKTOP_PACKAGES.get(PROTOCOL), DESKTOP_PACKAGES.get(PRELUDE)].flatMap(collectEdges);

		// When
		const violations = edges.filter(({ target }) => workspaceNames.has(target));

		// Then
		assert.deepEqual(describeEdges(violations), []);
	});

	it("ships exactly the five desktop packages, with no shared utils package", () => {
		// Given
		const desktopWorkspaces = findPackageDirectories(join(repoRoot, "packages"))
			.map((directory) => ({
				directory: relative(repoRoot, directory).replaceAll("\\", "/"),
				name: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name,
			}))
			// Fixture manifests may omit a name; only a named package can be imported.
			.filter(({ directory, name }) => /^packages\/desktop-[^/]+$/.test(directory) || name?.includes("senpi-desktop-"));

		// When
		const found = new Map(desktopWorkspaces.map(({ name, directory }) => [name, directory]));

		// Then
		assert.deepEqual([...found].sort(), [...DESKTOP_PACKAGES].sort());
	});
});
