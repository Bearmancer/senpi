import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readActiveRevision } from "../../src/environments/revision-store.ts";
import { hasCommand, packFixture, session, textOf } from "./js-magic-session.ts";

const shared: string[] = [];

afterEach(async () => {
	for (const dir of shared.splice(0)) await rm(dir, { recursive: true, force: true });
});

const probe = (name: string) => `export const ${name} = () => "${name}";\n`;

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))("Given JavaScript package revisions", () => {
	it("When two sessions sharing one managed root install at the same time, then each install lands in its own revision and both packages survive", async () => {
		const managedRoot = await mkdtemp(join(tmpdir(), "senpi-shared-managed-"));
		shared.push(managedRoot);
		const first = await session("npm", managedRoot);
		const second = await session("npm", managedRoot);
		const left = await packFixture(first.fixtures, "senpi-left", "1.0.0", probe("left"));
		const right = await packFixture(second.fixtures, "senpi-right", "1.0.0", probe("right"));

		const [one, two] = await Promise.all([first.run(`%npm add ${left}`), second.run(`%npm add ${right}`)]);
		const active = await readActiveRevision(join(managedRoot, "environments", "js", "test"));
		const manifest = JSON.parse(await readFile(join(active?.dir ?? "", "package.json"), "utf8"));

		expect([textOf(one), textOf(two)].map((text) => /revision (\d+)/.exec(text)?.[1]).sort()).toEqual(["1", "2"]);
		expect(active?.number).toBe(2);
		expect(Object.keys(manifest.dependencies).sort()).toEqual(["senpi-left", "senpi-right"]);
	}, 240_000);

	it("When a revision holds an .npmrc with credentials, then the next revision keeps its registry settings and drops every credential", async () => {
		const { fixtures, environments, run } = await session("npm");
		const first = await packFixture(fixtures, "senpi-first", "1.0.0", probe("first"));
		const second = await packFixture(fixtures, "senpi-second", "1.0.0", probe("second"));
		await run(`%npm add ${first}`);
		const firstRoot = environments.packageRoot ?? "";
		await writeFile(
			join(firstRoot, ".npmrc"),
			[
				"@acme:registry=https://registry.example.test/",
				"//registry.example.test/:_authToken=secret-token",
				"_auth=c2VjcmV0",
				"//registry.example.test/:_password=c2VjcmV0",
				"strict-ssl=true",
				"",
			].join("\n"),
		);

		await run(`%npm add ${second}`);
		const carried = await readFile(join(environments.packageRoot ?? "", ".npmrc"), "utf8");

		expect(carried).toContain("@acme:registry=https://registry.example.test/");
		expect(carried).toContain("strict-ssl=true");
		expect(carried).not.toContain("secret");
		expect(carried).not.toMatch(/_auth|_password/);
	}, 240_000);
});
