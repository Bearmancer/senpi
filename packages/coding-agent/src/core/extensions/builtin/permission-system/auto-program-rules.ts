import { type ClassifiedWord, classifyWords, type ProgramSpec, type WordRole } from "./auto-shell-grammar.ts";
import type { ShellWord } from "./auto-shell-segments.ts";

/** Classifies a command's words, or undefined when the program or any word is not understood. */
export type ProgramRule = (args: readonly ShellWord[]) => ClassifiedWord[] | undefined;

const all = (role: WordRole) => (): WordRole => role;
const lastIs =
	(last: WordRole, rest: WordRole) =>
	(index: number, count: number): WordRole =>
		index === count - 1 ? last : rest;
const firstIs =
	(first: WordRole, rest: WordRole) =>
	(index: number): WordRole =>
		index === 0 ? first : rest;

const flags = (names: string, role: true | WordRole = true): Record<string, true | WordRole> =>
	Object.fromEntries(names.split(" ").map((name) => [name, role]));

const spec =
	(value: ProgramSpec): ProgramRule =>
	(args) =>
		classifyWords(args, value);

/**
 * grep and rg: the first operand is the pattern unless a pattern came from `-e`/`--regexp`, in
 * which case every operand is a file to read.
 */
const searchSpec =
	(value: ProgramSpec): ProgramRule =>
	(args) => {
		const patternFromFlag = args.some(
			(word) => word.text === "--regexp" || word.text.startsWith("--regexp=") || /^-[^-]*e/.test(word.text),
		);
		return classifyWords(args, patternFromFlag ? { ...value, operand: all("read-file"), minOperands: 1 } : value);
	};

const READ_FILES: ProgramSpec = { flags: {}, operand: all("read-file") };

const SPECS: ReadonlyArray<readonly [string, ProgramRule]> = [
	["pwd", spec({ flags: {}, operand: all("text"), maxOperands: 0 })],
	["true", spec({ flags: {}, operand: all("text"), maxOperands: 0 })],
	["echo", spec({ flags: flags("-n -e -E"), operand: all("text") })],
	["which", spec({ flags: flags("-a"), operand: all("text"), minOperands: 1 })],
	[
		"ls",
		spec({
			flags: flags("-a -A -l -h -1 -R -t -S -r -d -F -p --all --almost-all --human-readable --recursive"),
			operand: all("list"),
		}),
	],
	["cat", spec({ ...READ_FILES, flags: flags("-n -b -s -A -e -t -v") })],
	["head", spec({ ...READ_FILES, flags: { ...flags("-n -c --lines --bytes", "text"), ...flags("-q -v --quiet") } })],
	["tail", spec({ ...READ_FILES, flags: { ...flags("-n -c --lines --bytes", "text"), ...flags("-q -v --quiet") } })],
	["wc", spec({ ...READ_FILES, flags: flags("-l -w -c -m -L --lines --words --bytes --chars") })],
	[
		"diff",
		spec({
			...READ_FILES,
			flags: { ...flags("-u -q -s -w -b -B -i --brief"), ...flags("-U --unified", "text") },
			minOperands: 2,
			maxOperands: 2,
		}),
	],
	["stat", spec({ flags: flags("-L"), operand: all("list"), minOperands: 1 })],
	["file", spec({ flags: flags("-b -i -L --brief --mime"), operand: all("read-file"), minOperands: 1 })],
	[
		"sort",
		spec({
			...READ_FILES,
			flags: {
				...flags("-r -n -u -f -b -d -h -V -s --reverse --numeric-sort --unique --ignore-case --stable"),
				...flags("-k -t --key --field-separator", "text"),
				...flags("-o --output", "write"),
			},
		}),
	],
	[
		"uniq",
		spec({
			flags: flags("-c -d -u -i --count --repeated --unique --ignore-case"),
			operand: firstIs("read-file", "write"),
			maxOperands: 2,
		}),
	],
	[
		"cut",
		spec({
			...READ_FILES,
			flags: {
				...flags("-d -f -c -b --delimiter --fields --characters --bytes", "text"),
				...flags("-s --only-delimited"),
			},
		}),
	],
	[
		"grep",
		searchSpec({
			flags: {
				...flags(
					"-i -n -c -l -L -v -w -x -o -q -s -H -h -F -E --ignore-case --line-number --count --fixed-strings --extended-regexp --files-with-matches",
				),
				...flags("-e -m -A -B -C --regexp --max-count --after-context --before-context --context", "text"),
			},
			operand: firstIs("text", "read-file"),
			minOperands: 1,
		}),
	],
	[
		"rg",
		searchSpec({
			flags: {
				...flags(
					"-i -n -c -l -v -w -x -o -F -S -N --ignore-case --line-number --count --fixed-strings --smart-case --files-with-matches --no-heading",
				),
				...flags("-e -m -A -B -C --regexp --max-count --after-context --before-context --context", "text"),
			},
			operand: firstIs("text", "read-file"),
			minOperands: 2,
		}),
	],
	["mkdir", spec({ flags: flags("-p --parents"), operand: all("write"), minOperands: 1 })],
	["touch", spec({ flags: {}, operand: all("write"), minOperands: 1 })],
	[
		"cp",
		spec({ flags: flags("-p -n --preserve --no-clobber"), operand: lastIs("write", "read-file"), minOperands: 2 }),
	],
	["mv", spec({ flags: flags("-n --no-clobber"), operand: lastIs("write", "remove-file"), minOperands: 2 })],
	["rm", spec({ flags: {}, operand: all("remove-file"), minOperands: 1 })],
];

const GIT_READ_SUBCOMMANDS: Readonly<Record<string, ProgramSpec>> = {
	status: { flags: flags("-s -b -u --short --branch --porcelain --untracked-files"), operand: all("list") },
	diff: {
		flags: flags("--stat --cached --staged --name-only --name-status --numstat --no-color --color -w"),
		operand: all("text"),
	},
	log: {
		flags: {
			...flags("--oneline --graph --decorate --stat --no-color --all --reverse --name-only --name-status"),
			...flags("-n --max-count --since --until --author --format --pretty", "text"),
		},
		operand: all("text"),
	},
	show: { flags: flags("--stat --name-only --name-status --oneline --no-color"), operand: all("text") },
	"rev-parse": { flags: flags("--abbrev-ref --short --show-toplevel --verify"), operand: all("text") },
	"ls-files": {
		flags: flags("-m -o -d -s --modified --others --deleted --stage --exclude-standard"),
		operand: all("list"),
	},
	blame: {
		flags: { ...flags("-w -s --porcelain"), ...flags("-L", "text") },
		operand: all("read-file"),
		minOperands: 1,
	},
	branch: {
		flags: flags("-a -r -v -vv --all --remotes --verbose --list --show-current"),
		operand: all("text"),
		maxOperands: 0,
	},
};

const SUMMARY_ONLY = new Set(["--stat", "--name-only", "--name-status", "--numstat"]);

/**
 * Read-only git subcommands only; any global option (`-c`, `-C`, `--git-dir`, a pager) asks.
 * `diff` and `show` print file contents, which can include a tracked secret, so they pass only in
 * a summary form, and no operand may name an object path (`HEAD:.env` prints that blob).
 */
const gitRule: ProgramRule = (args) => {
	const [sub, ...rest] = args;
	if (sub === undefined) return undefined;
	const subSpec = GIT_READ_SUBCOMMANDS[sub.text];
	if (subSpec === undefined || rest.some((word) => word.text.includes(":"))) return undefined;
	if ((sub.text === "diff" || sub.text === "show") && !rest.some((word) => SUMMARY_ONLY.has(word.text)))
		return undefined;
	return classifyWords(rest, subSpec);
};

export const PROGRAM_RULES: ReadonlyMap<string, ProgramRule> = new Map<string, ProgramRule>([
	...SPECS,
	["git", gitRule],
]);
