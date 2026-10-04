import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedCodemodeSettings } from "../config/settings.ts";
import { withRootLock } from "./install-lock.ts";
import {
	absoluteSpec,
	type JsInstallerChoice,
	parseJsPackages,
	resolveJsInstaller,
	runJsInstall,
} from "./js-installer.ts";
import type { EnvironmentMode } from "./py-environment.ts";
import { EnvironmentError } from "./py-installer.ts";
import { publishNextRevision, readActiveRevision } from "./revision-store.ts";

export interface JsInstallReceipt {
	readonly installer: "bun" | "npm";
	readonly mode: EnvironmentMode;
	readonly revision: number | undefined;
	readonly added: readonly string[];
	readonly shadowed: readonly string[];
}

export interface JsEnvironmentsOptions {
	readonly artifactsDir: string;
	readonly cwd: string;
	readonly runtime: string;
	readonly env: NodeJS.ProcessEnv;
	readonly settings: Pick<ResolvedCodemodeSettings, "environments">;
}

export class JsEnvironments {
	readonly #options: JsEnvironmentsOptions;
	#mode: EnvironmentMode = "managed";
	#packageRoot: string | undefined;

	constructor(options: JsEnvironmentsOptions) {
		this.#options = options;
	}

	get mode(): EnvironmentMode {
		return this.#mode;
	}

	get packageRoot(): string | undefined {
		return this.#mode === "managed" ? this.#packageRoot : undefined;
	}

	async setMode(mode: EnvironmentMode): Promise<string> {
		this.#mode = mode;
		if (mode === "project") return this.#options.cwd;
		this.#packageRoot = (await readActiveRevision(this.#managedBase()))?.dir;
		return this.#managedBase();
	}

	async install(
		requested: string,
		signal: AbortSignal,
		onOutput?: (stream: "stdout" | "stderr", data: string) => void,
		requestedInstaller?: "bun" | "npm",
	): Promise<JsInstallReceipt> {
		const environments = this.#options.settings.environments;
		if (environments?.autoProvision === false) {
			throw new EnvironmentError(
				"environment_installer_unavailable",
				"installs are turned off for this project (environments.autoProvision is false)",
			);
		}
		const packages = parseJsPackages(requested).map((spec) => absoluteSpec(spec, this.#options.cwd));
		// `%bun add` and `%npm add` name their installer; the setting applies only where the magic does not.
		const choice: JsInstallerChoice = requestedInstaller ?? environments?.js?.installer ?? "auto";
		const { installer, command } = resolveJsInstaller(choice, this.#options.env);
		const run = (root: string) =>
			runJsInstall({
				installer,
				command,
				root,
				packages,
				cwd: this.#options.cwd,
				env: this.#options.env,
				signal,
				...(onOutput === undefined ? {} : { onOutput }),
			});
		if (this.#mode === "project") {
			const before = await dependencyNames(this.#options.cwd);
			const lockRoot = join(this.#options.cwd, ".senpi", "js-packages");
			await mkdir(lockRoot, { recursive: true });
			await withRootLock(lockRoot, async () => await run(this.#options.cwd), signal);
			const added = (await dependencyNames(this.#options.cwd)).filter((name) => !before.includes(name));
			return { installer, mode: "project", revision: undefined, added, shadowed: [] };
		}
		let added: string[] = [];
		const { revision } = await publishNextRevision(
			this.#managedBase(),
			async (staging) => {
				await dropNpmrcCredentials(staging);
				const before = await dependencyNames(staging);
				await run(staging);
				added = (await dependencyNames(staging)).filter((name) => !before.includes(name));
			},
			signal,
		);
		this.#packageRoot = revision.dir;
		const shadowed = added.filter((name) => existsSync(join(this.#options.cwd, "node_modules", name)));
		return { installer, mode: "managed", revision: revision.number, added, shadowed };
	}

	#managedBase(): string {
		const root = this.#options.settings.environments?.managedRoot ?? this.#options.artifactsDir;
		return join(root, "environments", "js", this.#options.runtime);
	}
}

async function dependencyNames(root: string): Promise<string[]> {
	try {
		const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		if (typeof manifest !== "object" || manifest === null || !("dependencies" in manifest)) return [];
		const dependencies = manifest.dependencies;
		return typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

const NPMRC_CREDENTIAL =
	/^\s*(?:\/\/[^\s=]*:)?(?:_authToken|_auth|_password|username|password|email|certfile|keyfile)\s*=/i;

/**
 * A revision carries its `.npmrc` forward, so registry and scope settings keep working; credentials never do: any auth
 * line (global or `//host/:` scoped) is dropped before the next revision is built.
 */
async function dropNpmrcCredentials(root: string): Promise<void> {
	const path = join(root, ".npmrc");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return;
	}
	const kept = text.split(/\r?\n/).filter((line) => !NPMRC_CREDENTIAL.test(line));
	if (kept.length !== text.split(/\r?\n/).length) await writeFile(path, kept.join("\n"), { mode: 0o600 });
}
