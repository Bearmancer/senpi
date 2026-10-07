import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell spellings of the home directory, not a template.
const HOME_ANCHORS = ["~", "$HOME", "${HOME}", "%USERPROFILE%", "$env:USERPROFILE"] as const;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const QUOTED = /"([^"]*)"|'([^']*)'/g;
const BARE_WORD = /[^\s"'`;|&<>()]+/g;

function words(command: string): string[] {
	const quoted = [...command.matchAll(QUOTED)].map((match) => match[1] ?? match[2] ?? "");
	const bare = command.replace(QUOTED, " ").match(BARE_WORD) ?? [];
	return [...quoted, ...bare].flatMap((word) => word.split("="));
}

function withPlatformSeparators(path: string): string {
	return sep === "/" ? path.replaceAll("\\", "/") : path.replaceAll("/", "\\");
}

function expandHome(word: string): string | undefined {
	for (const anchor of HOME_ANCHORS) {
		if (word === anchor) return homedir();
		if (word.startsWith(`${anchor}/`) || word.startsWith(`${anchor}\\`))
			return withPlatformSeparators(`${homedir()}/${word.slice(anchor.length + 1)}`);
	}
	return undefined;
}

/**
 * The paths a shell command names (senpi#2898): absolute tokens, home-anchored tokens (`~`, `$HOME`,
 * `${HOME}`, `%USERPROFILE%`, `$env:USERPROFILE`), and relative tokens that contain a separator, resolved
 * against `cwd`. Quoted strings count as one token. A path the command assembles at run time is not seen.
 */
export function commandPaths(command: string, cwd: string): string[] {
	const paths: string[] = [];
	for (const word of words(command)) {
		const home = expandHome(word);
		if (home !== undefined) paths.push(home);
		else if (DRIVE_PATH.test(word)) paths.push(withPlatformSeparators(word));
		else if (isAbsolute(word)) paths.push(word);
		else if (word.includes("/") || word.includes("\\") || word.startsWith(".")) paths.push(resolve(cwd, word));
	}
	return paths;
}
