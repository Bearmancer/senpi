import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell spellings of the home directory, not a template.
const HOME_ANCHORS = ["~", "$HOME", "${HOME}", "%USERPROFILE%", "$env:USERPROFILE"] as const;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const QUOTED = /"([^"]*)"|'([^']*)'/g;
const BARE_WORD = /[^\s"'`;|&<>()]+/g;

/**
 * An anchored path anywhere in the text (senpi#2898 review H2): it starts after a shell or quote boundary, optionally
 * glued to a one-letter flag (`-C/path`), with `/`, a drive (`C:\`), or a home spelling followed by a separator, quote
 * or the end; it runs to the next shell metacharacter. Quotes inside it are dropped, as the shell drops them.
 */
const EMBEDDED_PATH =
	/(?<=^|[\s"'`=(),;|&<>:[{])(?:-[A-Za-z])?((?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=$|[\\/"'])|[A-Za-z]:[\\/]|\/)([^\s;|&<>()`,{}]*)/g;

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

function anchoredPath(word: string): string | undefined {
	const home = expandHome(word);
	if (home !== undefined) return home;
	if (DRIVE_PATH.test(word)) return withPlatformSeparators(word);
	return isAbsolute(word) ? word : undefined;
}

function embeddedPaths(command: string): string[] {
	return [...command.matchAll(EMBEDDED_PATH)].flatMap((match) => {
		const path = anchoredPath(`${match[1] ?? ""}${match[2] ?? ""}`.replace(/["']/g, ""));
		return path === undefined ? [] : [path];
	});
}

function words(command: string): string[] {
	const quoted = [...command.matchAll(QUOTED)].map((match) => match[1] ?? match[2] ?? "");
	const bare = command.replace(QUOTED, " ").match(BARE_WORD) ?? [];
	return [...quoted, ...bare].flatMap((word) => word.split("="));
}

/**
 * The paths a shell command names (senpi#2898): every anchored path embedded anywhere in the text (inline code,
 * flag values, quote-concatenated words), whole quoted strings that are paths (spaces included), and relative words
 * that contain a separator, resolved against `cwd`. A path the command assembles at run time is not seen.
 */
export function commandPaths(command: string, cwd: string): string[] {
	const paths = new Set(embeddedPaths(command));
	for (const word of words(command)) {
		const anchored = anchoredPath(word);
		if (anchored !== undefined) paths.add(anchored);
		else if (word.includes("/") || word.includes("\\") || word.startsWith(".")) paths.add(resolve(cwd, word));
	}
	return [...paths];
}
