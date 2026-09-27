import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	SUPPORTED_NATIVE_PREBUILD_TARGETS,
	assertSenpiPackedWorkspaceFiles,
	bundledWorkspacePackageChecks,
	nativePrebuildFile,
	nativePrebuildTarget,
} from "./prepare-senpi-bundled-workspaces.mjs";

const PTY_PACKAGE = "@earendil-works/pi-pty";
const DESKTOP_ENGINE_PACKAGE = "@code-yeongyu/senpi-desktop-engine";

function desktopFiles(prefix = "package/", engineTarget = nativePrebuildTarget()) {
	const root = `${prefix}node_modules/@code-yeongyu`;
	return [
		...["protocol", "prelude", "service", "tool", "engine"].flatMap((name) => [
			{ path: `${root}/senpi-desktop-${name}/package.json` },
			{ path: `${root}/senpi-desktop-${name}/dist/index.js` },
		]),
		{ path: `${root}/senpi-desktop-engine/native/index.js` },
		{ path: `${root}/senpi-desktop-engine/${nativePrebuildFile(engineTarget, DESKTOP_ENGINE_PACKAGE)}` },
	];
}

function clientProtocolFiles(prefix = "package/") {
	return [
		{ path: `${prefix}vendor/pi-client/index.js` },
		{ path: `${prefix}vendor/pi-client/index.d.ts` },
		{ path: `${prefix}vendor/pi-protocol/index.js` },
		{ path: `${prefix}vendor/pi-protocol/index.d.ts` },
	];
}

function chordFiles(prefix = "package/") {
	return [
		{ path: `${prefix}node_modules/@earendil-works/chord/package.json` },
		{ path: `${prefix}node_modules/@earendil-works/chord/dist/index.js` },
		{ path: `${prefix}node_modules/@earendil-works/chord/dist/context/index.js` },
	];
}

function agentCoreFiles(prefix = "package/") {
	return [
		{ path: `${prefix}node_modules/@earendil-works/pi-agent-core/package.json` },
		{ path: `${prefix}node_modules/@earendil-works/pi-agent-core/dist/index.js` },
		{ path: `${prefix}node_modules/@earendil-works/pi-agent-core/assets/tree-sitter/javascript.wasm` },
		{ path: `${prefix}node_modules/@earendil-works/pi-agent-core/assets/tree-sitter/web-tree-sitter.wasm` },
	];
}

function telemetryFiles(prefix = "package/") {
	return [
		{ path: `${prefix}node_modules/@earendil-works/pi-telemetry/package.json` },
		{ path: `${prefix}node_modules/@earendil-works/pi-telemetry/dist/index.js` },
	];
}

describe("assertSenpiPackedWorkspaceFiles", () => {
	it("keeps client and protocol outside bundled workspace checks", () => {
		const packageNames = bundledWorkspacePackageChecks().map((check) => check.packageName);

		assert.equal(packageNames.includes("@earendil-works/pi-client"), false);
		assert.equal(packageNames.includes("@earendil-works/pi-protocol"), false);
	});

	it("rejects resolver-visible client or protocol package paths", () => {
		const packed = {
			files: [{ path: "package/node_modules/@earendil-works/pi-client/package.json" }],
		};

		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed),
			/must keep client\/protocol outside package-manager node_modules/,
		);
	});

	it("rejects senpi package metadata that omits bundled workspace files", () => {
		// Given
		const packed = {
			files: [{ path: "package/dist/cli.js" }, { path: "package/CHANGELOG.md" }],
		};

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed),
			/package tarball is missing bundled workspace files: .*@earendil-works\/pi-ai/,
		);
	});

	it("rejects a packed tarball that omits a declared runtime dependency", () => {
		// Given: workspace bundles are present, but the cross-spawn registry dep is not vendored.
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget(), PTY_PACKAGE);
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				...clientProtocolFiles(),
				...desktopFiles(),
				...telemetryFiles(),
				...chordFiles(),
				...agentCoreFiles(),
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				...telemetryFiles(),
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `package/node_modules/@earendil-works/pi-pty/${hostPrebuild}` },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
				{ path: "package/node_modules/which/package.json" },
			],
		};

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed, { runtimeDependencies: ["cross-spawn", "which"] }),
			/missing vendored runtime dependencies: cross-spawn/,
		);
	});

	it("accepts a packed tarball whose declared runtime dependencies are all vendored", () => {
		// Given
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget(), PTY_PACKAGE);
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				...clientProtocolFiles(),
				...desktopFiles(),
				...telemetryFiles(),
				...chordFiles(),
				...agentCoreFiles(),
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				...telemetryFiles(),
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `package/node_modules/@earendil-works/pi-pty/${hostPrebuild}` },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/package.json" },
				{ path: "package/node_modules/cross-spawn/package.json" },
				{ path: "package/node_modules/@modelcontextprotocol/sdk/package.json" },
			],
		};

		// When / Then
		assert.doesNotThrow(() =>
			assertSenpiPackedWorkspaceFiles(packed, { runtimeDependencies: ["cross-spawn", "@modelcontextprotocol/sdk"] }),
		);
	});

	it("rejects a packed tarball that ships npm-shrinkwrap.json", () => {
		// Given: a shipped npm-shrinkwrap.json is fatal — npm treats it as the complete
		// locked tree and never installs the non-bundled direct deps (cross-spawn, the
		// MCP sdk, ...), so the installed CLI dies with ERR_MODULE_NOT_FOUND.
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget(), PTY_PACKAGE);
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				...clientProtocolFiles(),
				...desktopFiles(),
				...telemetryFiles(),
				{ path: "package/npm-shrinkwrap.json" },
				...chordFiles(),
				...agentCoreFiles(),
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				...telemetryFiles(),
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `package/node_modules/@earendil-works/pi-pty/${hostPrebuild}` },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
			],
		};

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed),
			/must not ship npm-shrinkwrap\.json/,
		);
	});

	it("rejects senpi package metadata that omits the codemode Babel parser", () => {
		// Given
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget(), PTY_PACKAGE);
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				...clientProtocolFiles(),
				...desktopFiles(),
				...telemetryFiles(),
				...chordFiles(),
				...agentCoreFiles(),
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `package/node_modules/@earendil-works/pi-pty/${hostPrebuild}` },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
			],
		};

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed),
			/missing bundled workspace files: .*senpi-codemode\/node_modules\/@babel\/parser\/package\.json/,
		);
	});

	it("accepts npm dry-run package metadata with unprefixed paths", () => {
		// Given
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget(), PTY_PACKAGE);
		const packed = {
			files: [
				{ path: "dist/cli.js" },
				...clientProtocolFiles(""),
				...desktopFiles(""),
				...telemetryFiles(""),
				...chordFiles(""),
				...agentCoreFiles(""),
				{ path: "node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `node_modules/@earendil-works/pi-pty/${hostPrebuild}` },
				{ path: "node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
				{ path: "node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/package.json" },
			],
		};

		// When / Then
		assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles(packed));
	});

	it("rejects senpi package metadata that omits the bundled pty native loader", () => {
		// Given
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				...clientProtocolFiles(),
				...desktopFiles(),
				...telemetryFiles(),
				...chordFiles(),
				...agentCoreFiles(),
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
			],
		};

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed),
			/package tarball is missing bundled workspace files: .*@earendil-works\/pi-pty\/native\/index\.js/,
		);
	});

	it("accepts senpi package metadata that omits the host pty prebuild (pipe fallback)", () => {
		// Given: all loader files present, but no host native prebuild.
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				...clientProtocolFiles(),
				...desktopFiles(),
				...telemetryFiles(),
				...chordFiles(),
				...agentCoreFiles(),
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/package.json" },
			],
		};

		// When / Then: the native prebuild is optional (pipe fallback), so this must not throw.
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles(packed));
		} finally {
			console.warn = originalWarn;
		}
	});

	it("accepts an all-OS check when a target's prebuild is absent (pipe fallback)", () => {
		// Given: the darwin-arm64 prebuild is present but linux-x64 is not.
		const missingTarget = "linux-x64";
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				...clientProtocolFiles(),
				...desktopFiles("package/", "darwin-arm64"),
				...chordFiles(),
				...agentCoreFiles(),
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				...telemetryFiles(),
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `package/node_modules/@earendil-works/pi-pty/${nativePrebuildFile("darwin-arm64", PTY_PACKAGE)}` },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/package.json" },
			],
		};

		// When / Then: a missing per-target prebuild is optional, so the check must not throw.
		assert.ok(SUPPORTED_NATIVE_PREBUILD_TARGETS.includes(missingTarget));
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			assert.doesNotThrow(() =>
				assertSenpiPackedWorkspaceFiles(packed, { nativePrebuildTargets: ["darwin-arm64", missingTarget] }),
			);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("publishes the supported native target list through package checks", () => {
		// When
		const checks = bundledWorkspacePackageChecks(SUPPORTED_NATIVE_PREBUILD_TARGETS);
		const ptyCheck = checks.find((check) => check.packageName === "@earendil-works/pi-pty");

		// Then
		assert.ok(ptyCheck);
		assert.deepEqual(
			ptyCheck.requiredFiles.filter((file) => file.startsWith("native/prebuilds/")),
			SUPPORTED_NATIVE_PREBUILD_TARGETS.map((target) => `native/prebuilds/${target}/senpi_pty.${target}.node`),
		);
	});

	it("names the desktop engine prebuild per target as the executable its locator expects", () => {
		// When
		const checks = bundledWorkspacePackageChecks(SUPPORTED_NATIVE_PREBUILD_TARGETS);
		const engineCheck = checks.find((check) => check.packageName === DESKTOP_ENGINE_PACKAGE);

		// Then
		assert.ok(engineCheck);
		assert.deepEqual(engineCheck.requiredFiles, [
			"package.json",
			"dist/index.js",
			"native/index.js",
			"native/prebuilds/darwin-arm64/senpi-desktop-engine",
			"native/prebuilds/darwin-x64/senpi-desktop-engine",
			"native/prebuilds/linux-arm64/senpi-desktop-engine",
			"native/prebuilds/linux-x64/senpi-desktop-engine",
			"native/prebuilds/win32-arm64/senpi-desktop-engine.exe",
			"native/prebuilds/win32-x64/senpi-desktop-engine.exe",
		]);
	});

	it("rejects a packed manifest that declares a never-published fork package (senpi#2141)", () => {
		// Given: the desktop workspaces are outside the publish set, so bun cannot resolve them.
		const packed = { files: [{ path: "package/dist/cli.js" }, ...desktopFiles()] };

		// When / Then
		assert.throws(
			() =>
				assertSenpiPackedWorkspaceFiles(packed, {
					runtimeDependencies: ["cross-spawn", DESKTOP_ENGINE_PACKAGE],
					bundledDependencies: ["cross-spawn", DESKTOP_ENGINE_PACKAGE],
				}),
			/declares packages that are never published.*@code-yeongyu\/senpi-desktop-engine/,
		);
	});

	it("does not require the files of never-published desktop workspaces the tarball leaves out", () => {
		// Given: every bundled file except the desktop workspaces, which are outside the publish set.
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				...clientProtocolFiles(),
				...telemetryFiles(),
				...chordFiles(),
				...agentCoreFiles(),
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser/package.json" },
			],
		};

		// When / Then
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles(packed));
		} finally {
			console.warn = originalWarn;
		}
	});
});
