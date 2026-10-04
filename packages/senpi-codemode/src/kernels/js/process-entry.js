// JavaScript kernel process-mode entry: worker-core over the framed subprocess transport.
//
// Trust model: process mode isolates CRASHES (memory, segfaults, out-of-memory), not hostile code. A cell runs in this
// process and can reach everything it holds, exactly like worker mode; hostile code belongs in isolate: true sandbox
// cells. The frame token below guards against ACCIDENTAL corruption of the channel (a cell's raw fd writes, a child
// process's output), not against a cell that sets out to forge frames.
//
// Channel: the host writes a random token as the first line of fd 0 and frames after it. Where the runtime allows it
// (Bun on macOS/Linux) the frame reader moves to a private duplicate of fd 0 and fd 0 becomes /dev/null, and fd 1 is
// re-pointed at a pipe whose bytes become text frames; frames go out on a writer opened on the original fd 1 before
// the re-point. Every frame is written as "<token> <json>", and the host parses only lines that carry it.
//
// Lifetime: the kernel exits the moment its control channel reaches end-of-file (the host closed it, exited or was
// killed). A watchdog thread also checks the parent pid and kills this process when the host is gone, so a cell
// that never yields (a busy loop, a blocking call) cannot keep the kernel alive past its host.
import { closeSync, createReadStream, openSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";

// Captured before any cell runs, so a cell that later replaces these never sees a frame being built.
const stringify = JSON.stringify;
const writeBytes = writeSync;
const exit = process.exit.bind(process);
const fromString = (text) => Buffer.from(text, "utf8");

// The host refuses a frame over 10 MiB; text is split well below it (a char can escape to 6 bytes of JSON).
const TEXT_CHUNK_CHARS = 1 << 20;
const FRAME_LIMIT_BYTES = 9 * 1024 * 1024;
// Values JSON cannot carry are sent as markers the host turns back into the value, matching worker mode. Each marker
// carries the frame token, so a cell's own data can never be taken for one.
const BIGINT_MARKER = "\u0000senpi:bigint:";
const UNDEFINED_MARKER = "\u0000senpi:undefined:";
const DRAIN_MARKER = "\u0000senpi-drain:";

function libcSymbols() {
	if (process.platform === "win32") return null;
	const libcPath = { darwin: "/usr/lib/libSystem.B.dylib", linux: "libc.so.6" }[process.platform];
	if (libcPath === undefined) return null;
	let ffi;
	try {
		ffi = createRequire(import.meta.url)("bun:ffi");
	} catch {
		return null;
	}
	return ffi.dlopen(libcPath, {
		dup: { args: [ffi.FFIType.i32], returns: ffi.FFIType.i32 },
		dup2: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
		pipe: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
	}).symbols;
}

const libc = libcSymbols();

/** The control channel's fd: a private duplicate of fd 0 where possible, so a cell reading fd 0 reads /dev/null. */
function privateControlFd() {
	if (libc === null) return 0;
	const duplicate = libc.dup(0);
	if (duplicate === -1) return 0;
	const devNull = openSync("/dev/null", "r");
	// dup2 returns the new descriptor (0) on success and -1 on failure.
	if (libc.dup2(devNull, 0) === -1) {
		closeSync(devNull);
		return duplicate;
	}
	closeSync(devNull);
	return duplicate;
}

/** Points fd 1 at a pipe this process reads, so raw fd 1 writes become text frames; null when unavailable. */
function repointStdoutToPipe() {
	if (libc === null) return null;
	const fds = new Int32Array(2);
	if (libc.pipe(fds) !== 0) return null;
	// dup2 returns the new descriptor (1) on success and -1 on failure.
	if (libc.dup2(fds[1], 1) === -1) return null;
	return { readFd: fds[0] };
}

const controlFd = privateControlFd();
const frameFd = process.platform === "win32" ? 1 : openSync("/dev/fd/1", "w");
const textPipe = repointStdoutToPipe();
const pause = new Int32Array(new SharedArrayBuffer(4));

/** Writes all of `bytes`, waiting out a full pipe; a closed channel means the host is gone, so the kernel exits. */
function writeAll(fd, bytes) {
	let offset = 0;
	while (offset < bytes.length) {
		try {
			offset += writeBytes(fd, bytes, offset, bytes.length - offset);
		} catch (error) {
			if (error?.code === "EAGAIN") {
				Atomics.wait(pause, 0, 0, 2);
				continue;
			}
			exit(0);
		}
	}
}

// Without the re-point, cell output shares the channel: a leading newline ends any unterminated output line, so the
// frame always starts its own line.
const framePrefix = textPipe === null ? "\n" : "";
let frameToken;

function replacer(_key, value) {
	if (typeof value === "bigint") return { [`${BIGINT_MARKER}${frameToken}`]: value.toString() };
	if (value === undefined) return { [`${UNDEFINED_MARKER}${frameToken}`]: 1 };
	return value;
}

function writeFrame(message) {
	const bytes = fromString(stringify(message, replacer));
	if (bytes.length <= FRAME_LIMIT_BYTES) {
		writeAll(frameFd, Buffer.concat([fromString(`${framePrefix}${frameToken} `), bytes, fromString("\n")]));
		return;
	}
	const tooLarge = (what) => ({ name: "RangeError", message: `${what} is too large to send (${bytes.length} bytes)` });
	if (message.type === "result") {
		const error = tooLarge("cell result");
		writeFrame({ type: "result", cellId: message.cellId, ok: false, error, durationMs: message.durationMs ?? 0 });
		return;
	}
	if (message.type === "tool-call") {
		// The host never sees the call, so the cell gets the refusal as the call's own failure instead of waiting on it.
		const reply = { type: "tool-reply", callId: message.callId, ok: false, error: tooLarge(`the ${message.toolName} call`) };
		queueMicrotask(() => deliver(reply));
		return;
	}
	const data = `[a ${message.type} message of ${bytes.length} bytes was too large to send and was dropped]\n`;
	writeFrame({ type: "text", stream: "stderr", data });
}

function sendFrame(message) {
	if (message.type !== "text" || typeof message.data !== "string" || message.data.length <= TEXT_CHUNK_CHARS) {
		writeFrame(message);
		return;
	}
	for (let start = 0; start < message.data.length; ) {
		let end = Math.min(start + TEXT_CHUNK_CHARS, message.data.length);
		// Never split a surrogate pair.
		if (end < message.data.length && /[\uD800-\uDBFF]/.test(message.data[end - 1])) end -= 1;
		writeFrame({ ...message, data: message.data.slice(start, end) });
		start = end;
	}
}

// Raw fd 1 output is read asynchronously. A result waits behind a drain marker written to the same pipe, so every
// byte a cell wrote before it returned reaches the host before its result.
const pendingResults = new Map();
let drainSequence = 0;
// The pipe is drained on its own thread: a cell that fills it from this thread (a child process inheriting fd 1, a
// writeSync loop) must never wait on a reader that only runs once the cell yields.
const DRAINER = `const { readSync } = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");
const buffer = Buffer.alloc(1 << 16);
for (;;) {
	let read;
	try {
		read = readSync(workerData.fd, buffer, 0, buffer.length, null);
	} catch (error) {
		if (error && error.code === "EAGAIN") continue;
		break;
	}
	if (read === 0) break;
	parentPort.postMessage(buffer.subarray(0, read).slice());
}`;
if (textPipe !== null) {
	const decoder = new StringDecoder("utf8");
	let carry = "";
	const reader = new Worker(DRAINER, { eval: true, workerData: { fd: textPipe.readFd } });
	reader.unref();
	reader.on("message", (data) => {
		const chunk = Buffer.from(data);
		let text = carry + decoder.write(chunk);
		carry = "";
		for (;;) {
			const at = text.indexOf(DRAIN_MARKER);
			if (at === -1) break;
			const close = text.indexOf("\u0000", at + DRAIN_MARKER.length);
			if (close === -1) break;
			if (at > 0) sendFrame({ type: "text", stream: "stdout", data: text.slice(0, at) });
			const key = text.slice(at + DRAIN_MARKER.length, close);
			const result = pendingResults.get(key);
			pendingResults.delete(key);
			if (result !== undefined) sendFrame(result);
			text = text.slice(close + 1);
		}
		// Keep a possible partial marker for the next chunk.
		const partial = text.lastIndexOf("\u0000");
		if (partial !== -1 && DRAIN_MARKER.startsWith(text.slice(partial, partial + DRAIN_MARKER.length))) {
			carry = text.slice(partial);
			text = text.slice(0, partial);
		}
		if (text.length > 0) sendFrame({ type: "text", stream: "stdout", data: text });
	});
}

// A cell that reads stdin sees an already-ended stream instead of the control channel.
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

const frameReader = createReadStream("", { fd: controlFd });
const frameLines = createInterface({ input: frameReader });
// End-of-file on the control channel means the host is gone (closed, exited or killed): never outlive it.
frameReader.once("end", () => exit(0));
frameReader.once("close", () => exit(0));
// The same, from a thread a running cell cannot block: once the parent pid changes the host is gone.
const WATCHDOG = `const { workerData } = require("node:worker_threads");
setInterval(() => {
	if (process.ppid !== workerData.parent) process.kill(process.pid, "SIGKILL");
}, 100);`;
new Worker(WATCHDOG, { eval: true, workerData: { parent: process.ppid } }).unref();

let lineHandler;
const bufferedLines = [];
function deliver(message) {
	if (lineHandler === undefined) bufferedLines.push(message);
	else lineHandler(message);
}
const tokenReceived = new Promise((resolve) => {
	frameLines.on("line", (line) => {
		if (frameToken === undefined) {
			frameToken = line;
			resolve();
			return;
		}
		if (line.length === 0) return;
		deliver(JSON.parse(line));
	});
});

const transport = {
	send(message) {
		if (message.type === "result" && textPipe !== null) {
			drainSequence += 1;
			const key = String(drainSequence);
			pendingResults.set(key, message);
			writeAll(1, fromString(`${DRAIN_MARKER}${key}\u0000`));
			return;
		}
		sendFrame(message);
	},
	onMessage(handler) {
		lineHandler = handler;
		for (const message of bufferedLines.splice(0)) handler(message);
		return () => frameLines.close();
	},
	close() {
		setTimeout(() => exit(0), 0);
	},
};

await tokenReceived;

// The crash cause reaches the host on stderr, tagged with the token, before the kernel ends (worker mode reports it
// through the thread's error event). It ends by SIGKILL, not process.exit: a crashed kernel runs no more code, and
// Node's exit can stall joining its own platform threads, which would keep a dead kernel and its cell waiting.
function reportCrash(error) {
	const cause = error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
	try {
		writeBytes(2, fromString(`\nsenpi-kernel-crash ${frameToken} ${stringify(cause)}\n`));
	} finally {
		process.kill(process.pid, "SIGKILL");
	}
}
process.on("uncaughtException", reportCrash);
process.on("unhandledRejection", reportCrash);

const cwd = process.env.SENPI_CODEMODE_PROCESS_CWD ?? process.cwd();
const poolWidth = Number.parseInt(process.env.SENPI_CODEMODE_PROCESS_POOL_WIDTH ?? "1", 10) || 1;
// Kernel plumbing, not the session's environment: cells and their children do not inherit it.
delete process.env.SENPI_CODEMODE_PROCESS_CWD;
delete process.env.SENPI_CODEMODE_PROCESS_POOL_WIDTH;

const { markKernelProcessMode } = await import("./worker-webview.js");
markKernelProcessMode();

const { createWorkerCore } = await import("./worker-core.js");

createWorkerCore(transport, {
	cwd,
	parallelPoolWidth: poolWidth,
	cwdInstallOptions: { allowMainThread: true },
	processModeMemory: true,
});
