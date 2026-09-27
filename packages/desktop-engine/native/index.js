import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveNativeDesktopEngine() {
	const host = `${process.platform}-${process.arch}`;
	const file = process.platform === "win32" ? "senpi-desktop-engine.exe" : "senpi-desktop-engine";
	const attemptedPath = join(dirname(fileURLToPath(import.meta.url)), "prebuilds", host, file);
	if (existsSync(attemptedPath)) {
		return { path: attemptedPath, diagnostic: null };
	}
	return {
		path: null,
		diagnostic: {
			code: "native-unavailable",
			host,
			attemptedPath,
			message: `No @code-yeongyu/senpi-desktop-engine prebuild is vendored for ${host}.`,
		},
	};
}

export const nativeDesktopEngine = resolveNativeDesktopEngine();
