/** Real supervisor with a SIGTERM-resistant socket child and event-controlled exit observation. */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { mock } from "node:test";
import { runHostSupervisor } from "../../src/modes/rpc/host-lifecycle.ts";

const [mode, socket, agentDir] = process.argv.slice(2);
if (mode === "host") {
	const address = process.argv.find((arg) => arg.startsWith("unix://"))?.slice(7);
	if (!address) throw new Error("missing internal socket");
	process.on("SIGTERM", () => {});
	net.createServer((peer) => peer.resume()).listen(address);
} else {
	if (!socket || !agentDir) throw new Error("missing supervisor paths");
	const timeout = globalThis.setTimeout;
	const waits = new Map<number, () => void>();
	let sequence = 0;
	mock.method(globalThis, "setTimeout", (run: () => void, ms: number) => {
		if (![2_000, 5_000, 30_000].includes(ms)) return timeout(run, ms);
		const timer = timeout(() => {}, 2_147_483_647);
		const id = ++sequence;
		waits.set(id, run);
		process.send?.({ type: "wait", id, ms });
		return timer;
	});
	const spawn = childProcess.spawn;
	let child: childProcess.ChildProcess | undefined;
	let releaseExit: (() => void) | undefined;
	mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
		child = spawn(...args);
		process.send?.({ type: "host", pid: child.pid });
		if (mode === "gate-exit") {
			// SIGKILL itself cannot be delayed deterministically: hold libuv's exit observation instead.
			let code: number | null = null;
			let signal: NodeJS.Signals | null = null;
			let released = false;
			Object.defineProperty(child, "exitCode", {
				get: () => (released ? code : null),
				set: (value) => {
					code = value;
				},
			});
			Object.defineProperty(child, "signalCode", {
				get: () => (released ? signal : null),
				set: (value) => {
					signal = value;
				},
			});
			const emit = child.emit;
			mock.method(child, "emit", (event: string | symbol, ...values: unknown[]) => {
				if (event !== "exit" || released) return emit.call(child, event, ...values);
				process.send?.({ type: "exit-held", pid: child?.pid });
				releaseExit = () => {
					released = true;
					emit.call(child, "exit", code, signal);
				};
				return true;
			});
		}
		child.once("exit", (code, signal) => process.send?.({ type: "reaped", pid: child?.pid, code, signal }));
		return child;
	});
	if (mode === "held-kill") {
		const kill = process.kill;
		mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
			if (pid === child?.pid && signal === "SIGKILL") {
				// A live child past the breaker cannot be manufactured with a real SIGKILL.
				process.send?.({ type: "kill-held", pid });
				return true;
			}
			return kill(pid, signal);
		});
	}
	const createServer = net.createServer;
	mock.method(net, "createServer", (...args: Parameters<typeof net.createServer>) => {
		const server = createServer(...args);
		server.once("listening", () => process.send?.({ type: "ready" }));
		return server;
	});
	syncBuiltinESMExports();
	process.on("message", (message: unknown) => {
		if (typeof message !== "object" || message === null || !("type" in message)) throw new Error("bad control");
		if (message.type === "release-exit") releaseExit?.();
		else if (message.type === "expire" && "id" in message && typeof message.id === "number") {
			const run = waits.get(message.id);
			if (!run) throw new Error("missing wait");
			waits.delete(message.id);
			run();
		}
	});
	await runHostSupervisor({
		socket,
		agentDir,
		hostArgs: [],
		childCommand: process.execPath,
		childArgs: [import.meta.filename, "host"],
	});
}
