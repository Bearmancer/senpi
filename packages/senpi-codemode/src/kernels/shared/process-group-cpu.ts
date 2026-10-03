/**
 * CPU time a process group has used so far, read from the kernel without spawning anything, in
 * platform units that only ever grow: the startup watchdog compares two readings and never converts.
 *
 * - darwin: every member from `proc_listpgrppids`, each `ri_user_time + ri_system_time` from
 *   `proc_pid_rusage(RUSAGE_INFO_V2)` (libproc, via `bun:ffi`);
 * - linux: every `/proc/<pid>/stat` whose process group is `pgid`, `utime + stime` in clock ticks;
 * - win32: `GetProcessTimes` kernel + user time of the process itself (Windows has no process
 *   groups, so a helper the runner starts is not counted there);
 * - anything else, or a runtime without `bun:ffi`: `undefined`, so the caller relies on output and
 *   stage events alone.
 *
 * `bun:ffi` is fetched with `process.getBuiltinModule` so the module still loads on Node, the same
 * runtime boundary `process-footprint.ts` in coding-agent uses. Every read is synchronous and never throws.
 */
import { readdirSync, readFileSync } from "node:fs";

type BunFfi = typeof import("bun:ffi");
type GroupCpuReader = (pgid: number) => bigint | undefined;

const RUSAGE_INFO_V2 = 2;
const RI_USER_TIME_OFFSET = 16;
const RI_SYSTEM_TIME_OFFSET = 24;
const RUSAGE_BUFFER_BYTES = 256;
const MAX_GROUP_MEMBERS = 4096;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

let groupReader: GroupCpuReader | null | undefined;

export function readProcessGroupCpuTime(pgid: number): bigint | undefined {
	if (!Number.isInteger(pgid) || pgid <= 0) return undefined;
	if (groupReader === undefined) groupReader = createGroupReader() ?? null;
	return groupReader?.(pgid);
}

/** `utime + stime` and the process group from `/proc/<pid>/stat` text, or `undefined` when malformed. */
export function parseProcStat(stat: string): { readonly pgrp: number; readonly cpuTicks: bigint } | undefined {
	// The command name may itself contain spaces or parentheses: the fields start after the last ")".
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const pgrp = Number(fields[2]);
	const utime = fields[11];
	const stime = fields[12];
	if (!Number.isInteger(pgrp) || utime === undefined || stime === undefined) return undefined;
	if (!/^\d+$/.test(utime) || !/^\d+$/.test(stime)) return undefined;
	return { pgrp, cpuTicks: BigInt(utime) + BigInt(stime) };
}

function createGroupReader(): GroupCpuReader | undefined {
	if (process.platform === "linux") return linuxGroupReader;
	if (process.platform !== "darwin" && process.platform !== "win32") return undefined;
	const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
	if (ffi === undefined) return undefined;
	try {
		return process.platform === "darwin" ? darwinGroupReader(ffi) : windowsProcessReader(ffi);
	} catch {
		// A library or symbol this build cannot bind: the watchdog falls back to output and stages.
		return undefined;
	}
}

function linuxGroupReader(pgid: number): bigint | undefined {
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return undefined;
	}
	let total = 0n;
	let members = 0;
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		let stat: string;
		try {
			stat = readFileSync(`/proc/${entry}/stat`, "utf8");
		} catch {
			// The process exited between the directory read and this one.
			continue;
		}
		const parsed = parseProcStat(stat);
		if (parsed === undefined || parsed.pgrp !== pgid) continue;
		total += parsed.cpuTicks;
		members += 1;
	}
	return members === 0 ? undefined : total;
}

function darwinGroupReader({ dlopen, FFIType, ptr }: BunFfi): GroupCpuReader {
	const library = dlopen("libSystem.B.dylib", {
		proc_listpgrppids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	});
	const pids = new Int32Array(MAX_GROUP_MEMBERS);
	const usage = new Uint8Array(RUSAGE_BUFFER_BYTES);
	const view = new DataView(usage.buffer);
	return (pgid) => {
		const count = library.symbols.proc_listpgrppids(pgid, ptr(pids), pids.byteLength);
		if (count <= 0) return undefined;
		let total = 0n;
		let members = 0;
		for (const pid of pids.subarray(0, Math.min(count, MAX_GROUP_MEMBERS))) {
			usage.fill(0);
			if (library.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V2, ptr(usage)) !== 0) continue;
			total += view.getBigUint64(RI_USER_TIME_OFFSET, true) + view.getBigUint64(RI_SYSTEM_TIME_OFFSET, true);
			members += 1;
		}
		return members === 0 ? undefined : total;
	};
}

function windowsProcessReader({ dlopen, FFIType, ptr }: BunFfi): GroupCpuReader {
	const library = dlopen("kernel32.dll", {
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		GetProcessTimes: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const times = new BigUint64Array(4);
	return (pid) => {
		const handle = library.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
		if (!handle) return undefined;
		try {
			times.fill(0n);
			const base = ptr(times);
			if (library.symbols.GetProcessTimes(handle, base, base + 8, base + 16, base + 24) === 0) return undefined;
			return (times[2] ?? 0n) + (times[3] ?? 0n);
		} finally {
			library.symbols.CloseHandle(handle);
		}
	};
}
