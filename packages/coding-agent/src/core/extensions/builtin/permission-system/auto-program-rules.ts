import type { ShellWord } from "./auto-shell-segments.ts";

export type ProgramRule = (args: readonly ShellWord[]) => boolean;

const SAFE_SCRIPT =
	/^(test|tests|build|lint|check|checks|typecheck|type-check|types|tsc|format|fmt|compile|verify)([:._-][\w:.-]*)?$/;
const GLOBAL_INSTALL_FLAGS = new Set(["-g", "--global", "-G", "--location=global"]);
const RUN_VALUE_FLAGS = new Set(["--filter", "-F", "-w", "--workspace", "--cwd", "-C", "--prefix", "--dir"]);

const texts = (args: readonly ShellWord[]) => args.map((arg) => arg.text);
const always: ProgramRule = () => true;
const firstIn =
	(...allowed: string[]): ProgramRule =>
	(args) =>
		args.length > 0 && allowed.includes(args[0].text);
const noArgOrFirstIn =
	(...allowed: string[]): ProgramRule =>
	(args) =>
		args.length === 0 || allowed.includes(args[0].text);

function scriptAfterRun(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (RUN_VALUE_FLAGS.has(arg)) {
			index += 1;
			continue;
		}
		if (!arg.startsWith("-")) return arg;
	}
	return undefined;
}

const isSafeScript = (name: string | undefined) => name !== undefined && SAFE_SCRIPT.test(name);
const isPackageSpecSafe = (args: readonly string[]) =>
	!args.some(
		(arg) => GLOBAL_INSTALL_FLAGS.has(arg) || /:\/\/|^git[+@]|^(github|gitlab|bitbucket|file|link):/.test(arg),
	);

function packageManagerRule(options: {
	readonly install: readonly string[];
	readonly bareScripts: boolean;
}): ProgramRule {
	return (words) => {
		const args = texts(words);
		if (!isPackageSpecSafe(args)) return false;
		const sub = args[0];
		if (sub === undefined) return options.install.includes("");
		if (options.install.includes(sub)) return true;
		if (sub === "test" || sub === "t") return true;
		if (sub === "run" || sub === "run-script") return isSafeScript(scriptAfterRun(args.slice(1)));
		return options.bareScripts && isSafeScript(sub);
	};
}

const GIT_READ_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"blame",
	"describe",
	"shortlog",
	"grep",
	"cat-file",
	"merge-base",
	"rev-list",
	"show-ref",
	"whatchanged",
	"count-objects",
]);
const GIT_BRANCH_FLAGS = new Set([
	"-a",
	"--all",
	"-r",
	"--remotes",
	"-v",
	"-vv",
	"--verbose",
	"--list",
	"-l",
	"--show-current",
]);
const GIT_BRANCH_VALUE_FLAGS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at"]);
const GIT_PAGER_FLAGS = /^(-O|--open-files-in-pager|--ext-diff$|--output)/;

const gitRule: ProgramRule = (words) => {
	const args = texts(words);
	let index = 0;
	while (index < args.length && args[index].startsWith("-")) {
		if (args[index] === "--no-pager") index += 1;
		else if (args[index] === "-C") index += 2;
		else return false;
	}
	const sub = args[index];
	const rest = args.slice(index + 1);
	if (sub === undefined) return false;
	if (rest.some((arg) => GIT_PAGER_FLAGS.test(arg))) return false;
	if (GIT_READ_SUBCOMMANDS.has(sub)) return true;
	if (sub === "branch") {
		for (let position = 0; position < rest.length; position += 1) {
			const arg = rest[position];
			if (GIT_BRANCH_VALUE_FLAGS.has(arg)) position += 1;
			else if (!GIT_BRANCH_FLAGS.has(arg) && !/^--(sort|format|color)=/.test(arg)) return false;
		}
		return true;
	}
	if (sub === "tag") return rest.length === 0 || rest[0] === "-l" || rest[0] === "--list";
	if (sub === "remote")
		return rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose"));
	if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
	if (sub === "config") return ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(rest[0] ?? "");
	if (sub === "reflog") return rest.length === 0 || rest[0] === "show";
	return false;
};

const FIND_ACTIONS = new Set([
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-fprint",
	"-fprint0",
	"-fprintf",
	"-fls",
]);
const RM_FORBIDDEN_FLAG = /^-[^-]*[rRfd]|^--(recursive|force|dir)$/;

const rmRule: ProgramRule = (words) => {
	const operands = words.filter((word) => !word.text.startsWith("-"));
	return (
		operands.length > 0 &&
		!words.some((word) => RM_FORBIDDEN_FLAG.test(word.text) || word.hasGlob) &&
		!operands.some((word) => word.text === "." || word.text === ".." || word.text === "/")
	);
};

const FILE_UTILITY_PROGRAMS = [
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"pwd",
	"echo",
	"printf",
	"which",
	"file",
	"stat",
	"du",
	"tree",
	"grep",
	"egrep",
	"fgrep",
	"uniq",
	"cut",
	"tr",
	"diff",
	"cmp",
	"basename",
	"dirname",
	"realpath",
	"date",
	"true",
	"false",
	"test",
	"jq",
	"nl",
	"tac",
	"sha256sum",
	"shasum",
	"md5sum",
	"cksum",
	"column",
	"mkdir",
	"touch",
	"cp",
	"mv",
];
const BUILD_TOOLS = [
	"tsc",
	"tsgo",
	"eslint",
	"prettier",
	"biome",
	"oxlint",
	"vitest",
	"jest",
	"pytest",
	"ruff",
	"mypy",
	"black",
	"isort",
];

export const PROGRAM_RULES: ReadonlyMap<string, ProgramRule> = new Map<string, ProgramRule>([
	...FILE_UTILITY_PROGRAMS.map((name) => [name, always] as const),
	...BUILD_TOOLS.map((name) => [name, always] as const),
	["rg", (args) => !args.some((arg) => arg.text === "--pre" || arg.text.startsWith("--pre="))],
	["sort", (args) => !args.some((arg) => arg.text.startsWith("--compress-program"))],
	["find", (args) => !args.some((arg) => FIND_ACTIONS.has(arg.text))],
	["rm", rmRule],
	["git", gitRule],
	["npm", packageManagerRule({ install: ["install", "i", "ci", "add"], bareScripts: false })],
	["pnpm", packageManagerRule({ install: ["install", "i", "add"], bareScripts: true })],
	["yarn", packageManagerRule({ install: ["", "install", "add"], bareScripts: true })],
	["bun", packageManagerRule({ install: ["install", "i", "add"], bareScripts: false })],
	["vp", packageManagerRule({ install: ["install", "i", "check", "lint", "fmt", "build"], bareScripts: false })],
	[
		"cargo",
		(args) =>
			!args.some((arg) => arg.text === "--config" || arg.text.startsWith("--config=")) &&
			firstIn(
				"build",
				"b",
				"test",
				"t",
				"check",
				"c",
				"clippy",
				"fmt",
				"doc",
				"bench",
				"tree",
				"metadata",
				"fetch",
			)(args),
	],
	[
		"go",
		(args) =>
			!args.some((arg) => /^-(exec|toolexec)(=|$)/.test(arg.text)) &&
			(firstIn("build", "test", "vet", "fmt", "list", "version")(args) ||
				(args[0]?.text === "mod" && firstIn("download", "tidy", "verify", "graph", "why")(args.slice(1)))),
	],
	["make", (args) => args.every((arg) => arg.text.startsWith("-") || isSafeScript(arg.text))],
	[
		"python",
		(args) =>
			args[0]?.text === "-m" &&
			firstIn("pytest", "unittest", "mypy", "ruff", "black", "isort", "compileall", "py_compile")(args.slice(1)),
	],
	[
		"python3",
		(args) =>
			args[0]?.text === "-m" &&
			firstIn("pytest", "unittest", "mypy", "ruff", "black", "isort", "compileall", "py_compile")(args.slice(1)),
	],
	[
		"uv",
		(args) =>
			args[0]?.text === "sync" ||
			(args[0]?.text === "run" && firstIn("pytest", "mypy", "ruff", "black")(args.slice(1))),
	],
	["deno", firstIn("test", "check", "lint", "fmt")],
	[
		"mvn",
		(args) =>
			args.length > 0 &&
			args.every(
				(arg) =>
					arg.text.startsWith("-") ||
					["test", "compile", "package", "verify", "validate", "clean"].includes(arg.text),
			),
	],
	[
		"gradle",
		(args) =>
			args.length > 0 &&
			args.every(
				(arg) => arg.text.startsWith("-") || ["test", "build", "check", "assemble", "clean"].includes(arg.text),
			),
	],
	["swift", firstIn("build", "test")],
	["dotnet", noArgOrFirstIn("build", "test", "restore")],
]);
