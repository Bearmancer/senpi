// JavaScript kernel process-mode entry: worker-core over the framed subprocess transport.
// fd 0 is the private frame reader. fd 1 is re-pointed at a pipe whose bytes become text frames,
// so a cell writing to fd 1 cannot corrupt the frame channel, which lives on a private writer
// opened on the original fd 1 before the re-point (the Ruby runner's STDOUT.dup pattern).
import { createReadStream, openSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

function repointStdoutToPipe() {
	if (process.platform === "win32") return null;
	const require = createRequire(import.meta.url);
	let ffi;
	try {
		ffi = require("bun:ffi");
	} catch {
		return null;
	}
	const libcPath = { darwin: "/usr/lib/libSystem.B.dylib", linux: "libc.so.6" }[process.platform];
	if (libcPath === undefined) return null;
	const libc = ffi.dlopen(libcPath, {
		dup2: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
		pipe: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
	});
	const fds = new Int32Array(2);
	if (libc.symbols.pipe(fds) !== 0) return null;
	if (libc.symbols.dup2(fds[1], 1) !== 0) return null;
	return { readFd: fds[0] };
}

// Frames ride the original fd 1; on Windows (no re-point) they share it with user output, which
// the js worker runtime already routes into text frames before anything reaches the fd.
const frameWrite =
	process.platform === "win32"
		? (line) => {
				process.stdout.write(line, () => {});
			}
		: (() => {
				const writer = openSync("/dev/fd/1", "w");
				return (line) => {
					try {
						writeSync(writer, line);
					} catch {
						// The host closed the channel; the kernel exits on its close frame or is reaped.
					}
				};
			})();

const textPipe = repointStdoutToPipe();

// A cell that reads stdin sees an already-ended stream instead of stealing frames off fd 0.
const ended = new Readable({
	read() {
		this.push(null);
	},
});
Object.defineProperty(process, "stdin", { value: ended, configurable: true });
if (globalThis.Bun !== undefined) {
	try {
		Object.defineProperty(globalThis.Bun, "stdin", { get: () => ended, configurable: true });
	} catch {
		// Bun.stdin is already non-configurable on this runtime
	}
}

if (textPipe !== null) {
	const reader = createReadStream("", { fd: textPipe.readFd });
	reader.on("data", (chunk) => {
		const text = chunk.toString("utf8");
		if (text.length > 0) transport.send({ type: "text", stream: "stdout", data: text });
	});
}

const frameReader = createReadStream("", { fd: 0 });

const transport = {
	send(message) {
		frameWrite(`${JSON.stringify(message)}\n`);
	},
	onMessage(handler) {
		const reader = createInterface({ input: frameReader });
		reader.on("line", (line) => {
			if (line.length === 0) return;
			handler(JSON.parse(line));
		});
		return () => reader.close();
	},
	close() {
		setTimeout(() => process.exit(0), 0);
	},
};

const { markKernelProcessMode } = await import("./worker-webview.js");
markKernelProcessMode();

const { createWorkerCore } = await import("./worker-core.js");

createWorkerCore(transport, {
	cwd: process.env.SENPI_CODEMODE_PROCESS_CWD ?? process.cwd(),
	parallelPoolWidth: Number.parseInt(process.env.SENPI_CODEMODE_PROCESS_POOL_WIDTH ?? "1", 10) || 1,
	cwdInstallOptions: { allowMainThread: true },
	processModeMemory: true,
});
