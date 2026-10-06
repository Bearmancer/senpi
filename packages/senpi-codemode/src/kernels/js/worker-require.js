import { createRequire, isBuiltin } from "node:module";

// `require` in a cell resolves the way `import` does there: relative paths from the cell's directory, bare packages
// from the session's project first and then its managed package environment (%bun add / %npm add), builtins natively.
// It uses the runtime's own CommonJS loader, so JSON files and the `require` export conditions behave as in Node.
// Like Node's own `require`, it carries `resolve`, `resolve.paths` and `cache`, all following that same order.
export function createCellRequire(context) {
	const requirers = () => {
		const { cwdUrl, packageRootUrl } = context();
		const fromCwd = createRequire(new URL("package.json", cwdUrl));
		const fromPackages = packageRootUrl ? createRequire(new URL("package.json", packageRootUrl)) : undefined;
		return { fromCwd, fromPackages };
	};
	const isPathLike = (name) => name.startsWith(".") || name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name);
	// The project first; a bare name it does not have falls back to the managed environment, and a miss there reports
	// the project's own not-found error, which names the module and where it looked first.
	const firstFound = (name, use) => {
		const { fromCwd, fromPackages } = requirers();
		if (isPathLike(name) || fromPackages === undefined) return use(fromCwd);
		try {
			return use(fromCwd);
		} catch (error) {
			if (error?.code !== "MODULE_NOT_FOUND") throw error;
			try {
				return use(fromPackages);
			} catch (fallback) {
				throw fallback?.code === "MODULE_NOT_FOUND" ? error : fallback;
			}
		}
	};
	const require = function require(specifier) {
		const name = String(specifier);
		if (name.startsWith("node:") || isBuiltin(name)) return process.getBuiltinModule(name);
		return firstFound(name, (load) => load(name));
	};
	const resolve = function resolve(specifier, options) {
		const name = String(specifier);
		if (name.startsWith("node:") || isBuiltin(name)) return name.startsWith("node:") ? name : `node:${name}`;
		return firstFound(name, (load) => load.resolve(name, options));
	};
	resolve.paths = (specifier) => {
		const name = String(specifier);
		if (name.startsWith("node:") || isBuiltin(name)) return null;
		const { fromCwd, fromPackages } = requirers();
		const paths = fromCwd.resolve.paths(name) ?? [];
		return fromPackages === undefined || isPathLike(name) ? paths : [...paths, ...(fromPackages.resolve.paths(name) ?? [])];
	};
	require.resolve = resolve;
	// One CommonJS cache per runtime: the cell's view is the loader's own, so deleting an entry forces a reload.
	Object.defineProperty(require, "cache", { enumerable: true, get: () => createRequire(import.meta.url).cache });
	return require;
}

export { createRequire };
