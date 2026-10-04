import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ResolvedCodemodeSettings } from "../config/settings.ts";
import { withRootLock } from "./install-lock.ts";
import {
	absoluteSpec,
	type JsInstallerChoice,
	parseJsPackages,
	resolveJsInstaller,
	runJsInstall,
	withoutHostPaths,
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
		let recordedSpecs: readonly string[] = [];
		const run = (root: string) =>
			runJsInstall({
				installer,
				command,
				root,
				packages,
				recordedSpecs,
				cwd: this.#options.cwd,
				env: this.#options.env,
				signal,
				...(onOutput === undefined ? {} : { onOutput }),
			});
		// The lock and the revision store fail with raw file system errors; they reach the cell redacted.
		const redacted = (root: string) => (error: unknown) => {
			if (error instanceof EnvironmentError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			const text = withoutHostPaths(message, { root, cwd: this.#options.cwd, packages, recordedSpecs });
			throw new EnvironmentError("environment_install_failed", text);
		};
		if (this.#mode === "project") {
			const before = await dependencyNames(this.#options.cwd);
			const lockRoot = join(this.#options.cwd, ".senpi", "js-packages");
			await mkdir(lockRoot, { recursive: true });
			await withRootLock(lockRoot, async () => await run(this.#options.cwd), signal).catch(redacted(lockRoot));
			const added = (await dependencyNames(this.#options.cwd)).filter((name) => !before.includes(name));
			return { installer, mode: "project", revision: undefined, added, shadowed: [] };
		}
		let added: string[] = [];
		const { revision } = await publishNextRevision(
			this.#managedBase(),
			async (staging) => {
				await carryNpmrcSettings(staging);
				await rm(join(staging, "bunfig.toml"), { recursive: true, force: true });
				const before = await dependencyNames(staging);
				recordedSpecs = await absoluteDependencySpecs(staging);
				await run(staging);
				added = (await dependencyNames(staging)).filter((name) => !before.includes(name));
			},
			signal,
		).catch(redacted(this.#managedBase()));
		this.#packageRoot = revision.dir;
		const shadowed = added.filter((name) => projectResolves(this.#options.cwd, name));
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

const NPMRC_CARRIED_KEY = /^(?:registry|@[^\s=:/]+:registry|strict-ssl|ca|cafile)$/;

/**
 * A revision carries forward only the registry settings of its `.npmrc`: `registry`, `@scope:registry`, `strict-ssl`,
 * `ca` and `cafile`. Every other key, credentials included, is dropped by default, and the file is rewritten as a
 * regular file: a symlinked `.npmrc` is replaced, never written through, so the file it pointed at stays untouched.
 */
async function carryNpmrcSettings(root: string): Promise<void> {
	const path = join(root, ".npmrc");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		await rm(path, { recursive: true, force: true });
		return;
	}
	const kept = text
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter((line) => {
			const key = line.split("=", 1)[0]?.trim() ?? "";
			return line.includes("=") && NPMRC_CARRIED_KEY.test(key);
		})
		// A registry URL may carry `user:password@`; that is a credential, so it is dropped too.
		.map((line) => line.replace(/^([^=]*registry\s*=\s*["']?[a-z][a-z0-9+.-]*:\/\/)[^@/\s"']*@/i, "$1"));
	await rm(path, { recursive: true, force: true });
	if (kept.length > 0) await writeFile(path, `${kept.join("\n")}\n`, { mode: 0o600, flag: "wx" });
}

/** Absolute paths (or `file:` paths) a revision's `package.json` already records: the installer echoes them. */
async function absoluteDependencySpecs(root: string): Promise<string[]> {
	try {
		const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		if (typeof manifest !== "object" || manifest === null || !("dependencies" in manifest)) return [];
		const dependencies = manifest.dependencies;
		if (typeof dependencies !== "object" || dependencies === null) return [];
		return Object.values(dependencies).flatMap((spec) => {
			if (typeof spec !== "string") return [];
			const path = spec.startsWith("file:") ? spec.slice("file:".length) : spec;
			return isAbsolute(path) ? [path] : [];
		});
	} catch {
		return [];
	}
}

/**
 * Whether a bare import of `name` from the session directory resolves in the project before a managed revision:
 * the host-side twin of the kernel resolver's lookup (`worker-package-resolve.js`, which stays plain JavaScript).
 * Like the resolver it stops at the first `node_modules/<name>` directory up the chain, and that directory wins
 * only when it has an entry: a `package.json`, or the `index.js` a manifest-less package falls back to.
 */
function projectResolves(cwd: string, name: string): boolean {
	for (let directory = cwd; ; directory = dirname(directory)) {
		const candidate = join(directory, "node_modules", name);
		if (isDirectory(candidate)) {
			return existsSync(join(candidate, "package.json")) || existsSync(join(candidate, "index.js"));
		}
		if (dirname(directory) === directory) return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
