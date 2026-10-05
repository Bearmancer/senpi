import { join } from "node:path";
import type { CodemodeSettings } from "./settings.ts";

/**
 * `languages.pyInterpreter` names an executable that runs at session start (its `--version` probe), before the user
 * does anything. A project's own settings file may set it only when the project is trusted; otherwise it is dropped
 * with a warning, and the executable it names is never run.
 */
export function withoutUntrustedInterpreter<Settings extends CodemodeSettings>(
	settings: Settings,
	source: string | null,
	cwd: string,
	projectTrusted: boolean,
): { readonly settings: Settings; readonly warning?: string } {
	const interpreter = settings.languages.pyInterpreter;
	const projectFile = join(cwd, ".senpi", "codemode.json");
	if (interpreter === undefined || source !== projectFile || projectTrusted) return { settings };
	const { pyInterpreter: _ignored, ...languages } = settings.languages;
	return {
		settings: { ...settings, languages },
		warning: `languages.pyInterpreter "${interpreter}" in ${projectFile} is ignored because this project is not trusted; it was not run`,
	};
}
