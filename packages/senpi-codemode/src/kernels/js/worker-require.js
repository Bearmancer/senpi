import { createRequire, isBuiltin } from "node:module";

// `require` in a cell resolves the way `import` does there: relative paths from the cell's directory, bare packages
// from the session's project first and then its managed package environment (%bun add / %npm add), builtins natively.
// It uses the runtime's own CommonJS loader, so JSON files and the `require` export conditions behave as in Node.
export function createCellRequire(context) {
	return function require(specifier) {
		const name = String(specifier);
		if (name.startsWith("node:") || isBuiltin(name)) return process.getBuiltinModule(name);
		const { cwdUrl, packageRootUrl } = context();
		const fromCwd = createRequire(new URL("package.json", cwdUrl));
		if (name.startsWith(".") || name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name) || !packageRootUrl) return fromCwd(name);
		try {
			return fromCwd(name);
		} catch (error) {
			if (error?.code !== "MODULE_NOT_FOUND") throw error;
			try {
				return createRequire(new URL("package.json", packageRootUrl))(name);
			} catch (fallback) {
				throw fallback?.code === "MODULE_NOT_FOUND" ? error : fallback;
			}
		}
	};
}

export { createRequire };
