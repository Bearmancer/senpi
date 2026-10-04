// JavaScript kernel process-mode entry: worker-core over the framed subprocess transport.
// fd 0 is the private frame reader. fd 1 is re-pointed at a pipe whose bytes become text frames
// where the runtime allows it (Bun on macOS/Linux); frames go out on a writer opened on the
// original fd 1 before the re-point.
//
// Frame authenticity does not rest on which fd a frame rides: any code in this process can reach
// every fd. The host's first stdin line is a random token, read into this module's scope before
// any cell runs; every frame is written as "<token> <json>", and the host parses only lines that
// carry it. Anything else that reaches the channel (a cell's raw fd writes, a child process's
// output) is delivered as plain output text, never as a frame.
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
	// dup2 returns the new descriptor (1) on success and -1 on failure.
	if (libc.symbols.dup2(fds[1], 1) === -1) return null;
	return { readFd: fds[0] };
}

// Captured before any cell runs, so a cell that later replaces JSON.stringify or fs.writeSync never
// sees a frame (or the token in it).
const stringify = JSON.stringify;
const writeFrameBytes = writeSync;
const frameFd = process.platform === "win32" ? 1 : openSync("/dev/fd/1", "w");
function frameWrite(line) {
	try {
		writeFrameBytes(frameFd, line);
	} catch {
		// The host closed the channel; the kernel exits on its close frame or is reaped.
	}
}

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
const frameLines = createInterface({ input: frameReader });
let frameToken;
let lineHandler;
const bufferedLines = [];
const tokenReceived = new Promise((resolve) => {
	frameLines.on("line", (line) => {
		if (frameToken === undefined) {
			frameToken = line;
			resolve();
			return;
		}
		if (line.length === 0) return;
		const message = JSON.parse(line);
		if (lineHandler === undefined) bufferedLines.push(message);
		else lineHandler(message);
	});
});
// Without the re-point, cell output shares the channel: a leading newline ends any unterminated
// output line, so the frame always starts its own line.
const framePrefix = textPipe === null ? "\n" : "";

const transport = {
	send(message) {
		frameWrite(`${framePrefix}${frameToken} ${stringify(message)}\n`);
	},
	onMessage(handler) {
		lineHandler = handler;
		for (const message of bufferedLines.splice(0)) handler(message);
		return () => frameLines.close();
	},
	close() {
		setTimeout(() => process.exit(0), 0);
	},
};

await tokenReceived;

const { markKernelProcessMode } = await import("./worker-webview.js");
markKernelProcessMode();

const { createWorkerCore } = await import("./worker-core.js");

createWorkerCore(transport, {
	cwd: process.env.SENPI_CODEMODE_PROCESS_CWD ?? process.cwd(),
	parallelPoolWidth: Number.parseInt(process.env.SENPI_CODEMODE_PROCESS_POOL_WIDTH ?? "1", 10) || 1,
	cwdInstallOptions: { allowMainThread: true },
	processModeMemory: true,
});
