import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isUnpublishedForkPackage } from "./registry-packages.mjs";

const SHIPPED_MODULE_EXTENSIONS = /\.(?:js|mjs|cjs)$/;

function listShippedModules(directory) {
	if (!existsSync(directory)) return [];
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...listShippedModules(path));
		else if (SHIPPED_MODULE_EXTENSIONS.test(entry.name)) files.push(path);
	}
	return files;
}

function importsPackage(source, packageName) {
	return [`"${packageName}"`, `'${packageName}'`, `"${packageName}/`, `'${packageName}/`].some((specifier) =>
		source.includes(specifier),
	);
}

function declaredDependencyNames(manifestPath) {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	return ["dependencies", "optionalDependencies", "peerDependencies"].flatMap((field) =>
		Object.keys(manifest[field] ?? {}),
	);
}

/**
 * Bundled workspaces that stay out of the published senpi tarball: fork-scope packages outside the
 * publish set. Nothing shipped may reach them, because the tarball would have to declare them and bun
 * resolves every declared dependency from the registry, where they do not exist (senpi#2141). Reach is
 * measured on the built coding-agent `dist/` and on the manifests of the bundled workspaces that ship,
 * so a module that starts importing one fails the release instead of publishing an uninstallable CLI.
 */
export function unpublishedBundledWorkspaces(repoRoot, workspaces) {
	const unpublished = workspaces.filter((workspace) => isUnpublishedForkPackage(workspace.packageName));
	if (unpublished.length === 0) return new Set();
	const names = unpublished.map((workspace) => workspace.packageName);
	const reached = [];
	const codingAgentDir = join(repoRoot, "packages/coding-agent");
	for (const file of listShippedModules(join(codingAgentDir, "dist"))) {
		const source = readFileSync(file, "utf8");
		for (const name of names.filter((candidate) => importsPackage(source, candidate))) {
			reached.push(`${name} (imported by packages/coding-agent/${relative(codingAgentDir, file)})`);
		}
	}
	const declarers = [
		{ label: "packages/coding-agent/package.json", manifestPath: join(codingAgentDir, "package.json") },
		...workspaces
			.filter((workspace) => !isUnpublishedForkPackage(workspace.packageName))
			.map((workspace) => ({
				label: `${workspace.source}/package.json`,
				manifestPath: join(repoRoot, workspace.source, "package.json"),
			})),
	];
	for (const { label, manifestPath } of declarers) {
		if (!existsSync(manifestPath)) continue;
		const declared = new Set(declaredDependencyNames(manifestPath));
		for (const name of names.filter((candidate) => declared.has(candidate))) {
			reached.push(`${name} (declared by ${label})`);
		}
	}
	if (reached.length > 0) {
		throw new Error(
			`The published senpi tarball reaches packages that are never published: ${reached.join("; ")}. ` +
				"bun resolves every declared dependency from the registry even when it is bundled, so add each to " +
				"the publish set in scripts/registry-packages.mjs before shipping code that uses it (senpi#2141).",
		);
	}
	return new Set(names);
}
