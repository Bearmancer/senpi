#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = join(scriptDir, "..", "..", "..");

/** What this gate vendors. The pty gate is the same shape for a napi `.node`. */
export const PREBUILD = {
	crate: "senpi-desktop-engine",
	packagePath: ["packages", "desktop-engine"],
	targetDirName: "senpi-desktop-engine-prebuild",
	/** Compile-time env the binary embeds; unset so the vendored bytes are reproducible. */
	volatileBuildEnv: ["SENPI_DESKTOP_BUILD_SHA"],
};

const rustTargetByHost = new Map([
	["darwin-arm64", "aarch64-apple-darwin"],
	["darwin-x64", "x86_64-apple-darwin"],
	["linux-arm64", "aarch64-unknown-linux-gnu"],
	["linux-x64", "x86_64-unknown-linux-gnu"],
	["win32-arm64", "aarch64-pc-windows-msvc"],
	["win32-x64", "x86_64-pc-windows-msvc"],
]);

export function getHost(platform = process.platform, arch = process.arch) {
	return `${platform}-${arch}`;
}

export function getBinaryName(host) {
	return host.startsWith("win32-") ? `${PREBUILD.crate}.exe` : PREBUILD.crate;
}

export function getVendoredPrebuildPath(rootDir, host) {
	return join(rootDir, ...PREBUILD.packagePath, "native", "prebuilds", host, getBinaryName(host));
}

export async function checkPrebuildFreshness(options = {}) {
	const rootDir = options.rootDir ?? defaultRootDir;
	const host = options.host ?? getHost();
	const rustTarget = options.rustTarget ?? rustTargetByHost.get(host);
	if (!rustTarget) {
		throw new Error(`error: unsupported native prebuild host target ${host}`);
	}

	const builtFile =
		options.builtFile ??
		(await buildHostPrebuild({
			host,
			rootDir,
			rustTarget,
			targetDir: join(rootDir, "target", PREBUILD.targetDirName, host),
		}));
	const vendoredFile = getVendoredPrebuildPath(rootDir, host);

	if (options.update) {
		await mkdir(dirname(vendoredFile), { recursive: true });
		await copyFile(builtFile, vendoredFile);
		await chmod(vendoredFile, 0o755);
		return { builtFile, host, rustTarget, status: "updated", vendoredFile };
	}

	await assertFileExists(vendoredFile, `error: missing vendored prebuild for ${host}: ${vendoredFile}`);
	const [builtBytes, vendoredBytes] = await Promise.all([readFile(builtFile), readFile(vendoredFile)]);
	if (!builtBytes.equals(vendoredBytes)) {
		throw new Error(
			`error: stale vendored prebuild for ${host}: ${vendoredFile} differs from rebuilt ${builtFile} (${rustTarget})`,
		);
	}

	return { builtFile, host, rustTarget, status: "fresh", vendoredFile };
}

async function buildHostPrebuild({ rootDir, host, rustTarget, targetDir }) {
	await run(
		"cargo",
		[
			"build",
			"--release",
			"-p",
			PREBUILD.crate,
			"--locked",
			"--target",
			rustTarget,
			"--target-dir",
			targetDir,
		],
		rootDir,
	);

	const builtFile = join(targetDir, rustTarget, "release", getBinaryName(host));
	await assertFileExists(builtFile, `error: cargo build did not produce expected host target ${host}: ${builtFile}`);
	return builtFile;
}

function run(command, args, cwd) {
	const env = { ...process.env, RUSTFLAGS: appendRustflags(process.env.RUSTFLAGS, `--remap-path-prefix=${cwd}=.`) };
	for (const name of PREBUILD.volatileBuildEnv) delete env[name];
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, shell: false, stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`error: ${command} ${args.join(" ")} failed with exit ${code ?? 1}`));
			}
		});
	});
}

function appendRustflags(current, flag) {
	return current ? `${current} ${flag}` : flag;
}

async function assertFileExists(file, message) {
	try {
		await access(file, fsConstants.R_OK);
	} catch {
		throw new Error(message);
	}
}

function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--update") {
			options.update = true;
		} else if (arg === "--host") {
			options.host = argv[++i];
		} else if (arg.startsWith("--host=")) {
			options.host = arg.slice("--host=".length);
		} else if (arg === "--root") {
			options.rootDir = argv[++i];
		} else if (arg.startsWith("--root=")) {
			options.rootDir = arg.slice("--root=".length);
		} else if (arg === "--built-file") {
			options.builtFile = argv[++i];
		} else if (arg.startsWith("--built-file=")) {
			options.builtFile = arg.slice("--built-file=".length);
		} else {
			throw new Error(`error: unknown argument ${arg}`);
		}
	}
	return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const result = await checkPrebuildFreshness(parseArgs(process.argv.slice(2)));
		console.log(`${result.status} native prebuild for ${result.host}: ${result.vendoredFile}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
