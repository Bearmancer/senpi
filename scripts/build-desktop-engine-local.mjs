#!/usr/bin/env node
/**
 * Local-dev helper: build senpi-desktop-engine for this host into the repository
 * `target/release/`, the dev candidate `@code-yeongyu/senpi-desktop-engine`'s
 * locator checks after the compiled sidecar and the vendored prebuild, then prove
 * the binary starts with `--selftest`.
 *
 * `--target-dir` is explicit so a redirected CARGO_TARGET_DIR cannot move the
 * binary away from where the locator looks. Refreshing the tracked vendored
 * prebuild is a different job: `bun run --cwd packages/desktop-engine check:prebuild -- --update`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binaryName = process.platform === "win32" ? "senpi-desktop-engine.exe" : "senpi-desktop-engine";
const targetDir = join(repoRoot, "target");

const build = spawnSync(
	"cargo",
	["build", "--release", "-p", "senpi-desktop-engine", "--locked", "--target-dir", targetDir],
	{ cwd: repoRoot, stdio: "inherit" },
);
if (build.status !== 0) {
	process.exit(build.status ?? 1);
}

const binary = join(targetDir, "release", binaryName);
if (!existsSync(binary)) {
	process.stderr.write(`build-desktop-engine-local: cargo produced no ${binary}\n`);
	process.exit(1);
}

const selftest = spawnSync(binary, ["--selftest"], { stdio: "inherit" });
if (selftest.status !== 0) {
	process.stderr.write(`build-desktop-engine-local: ${binary} --selftest exited ${selftest.status ?? "by signal"}\n`);
	process.exit(selftest.status ?? 1);
}
process.stdout.write(`build-desktop-engine-local: ${relative(repoRoot, binary)}\n`);
