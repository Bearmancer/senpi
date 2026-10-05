import { join } from "node:path";
import type { CodemodeSettings } from "./settings.ts";

/**
 * `languages.pyInterpreter` names an executable that runs at session start (its `--version` probe), before the user
 * does anything. A project's own settings file may set it only when the project is trusted; otherwise it is dropped
 * with a warning, and the executable it names is never run. Trust is asked only when a project file names an
 * interpreter, so a host that cannot answer still starts sessions; such a host counts as not trusting the project.
 */
export function withoutUntrustedInterpreter<Settings extends CodemodeSettings>(
	settings: Settings,
	source: string | null,
	cwd: string,
	isProjectTrusted: (() => boolean) | undefined,
): { readonly settings: Settings; readonly warning?: string } {
	const interpreter = settings.languages.pyInterpreter;
	const projectFile = join(cwd, ".senpi", "codemode.json");
	if (interpreter === undefined || source !== projectFile) return { settings };
	if (isProjectTrusted?.() === true) return { settings };
	const { pyInterpreter: _ignored, ...languages } = settings.languages;
	return {
		settings: { ...settings, languages },
		warning: `languages.pyInterpreter "${interpreter}" in ${projectFile} is ignored because this project is not trusted; it was not run`,
	};
}
