import { execFile } from "node:child_process";
import { foreignSessionHolders } from "../../core/foreign-session-holders.ts";
import type { RpcInboundRecord } from "./rpc-types.ts";
import { RPC_ERROR_SESSION_HELD } from "./rpc-types.ts";
import type { RpcSessionBinding } from "./session-binding.ts";
import { type RpcSessionEntry, RpcSessionRegistryError } from "./session-registry-types.ts";

// Admission is conservative: a new command must pass the guard unless it is explicitly
// a read or a control needed to finish/cancel an already-admitted turn.
const READ_ONLY_OR_CONTROL = new Set<RpcInboundRecord["type"]>([
	"get_state",
	"get_steering_messages",
	"get_follow_up_messages",
	"get_available_models",
	"get_available_thinking_levels",
	"get_fast_mode",
	"get_session_stats",
	"get_fork_messages",
	"get_entries",
	"get_tree",
	"get_last_assistant_text",
	"get_messages",
	"get_media",
	"get_commands",
	"get_loaded_surfaces",
	"get_auth_providers",
	"get_provider_accounts",
	"memory_report",
	"export_html",
	"export_jsonl",
	"abort",
	"interrupt",
	"abort_compaction",
	"abort_branch_summary",
	"abort_retry",
	"abort_bash",
	"clear_queue",
	"check_reload_veto",
	"cleanup_bash_output",
	"set_client_info",
	"extension_ui_response",
	"extension_ui_progress",
]);

/** One bounded identity snapshot for all foreign PIDs, never one subprocess per lease. */
function readProcessStarts(): Promise<ReadonlyMap<number, number>> {
	const windows = process.platform === "win32";
	const command = windows ? "powershell.exe" : "ps";
	const args = windows
		? [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { if ($null -ne $_.CreationDate) { "{0} {1}" -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString("o") } }',
			]
		: ["-axo", "pid=,lstart="];
	return new Promise((resolve) => {
		execFile(command, args, { timeout: 1_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
			const starts = new Map<number, number>();
			if (!error)
				for (const line of stdout.split("\n")) {
					const row = /^\s*(\d+)\s+(.+)$/.exec(line);
					if (!row) continue;
					const start = Date.parse(row[2]);
					if (Number.isFinite(start)) starts.set(Number(row[1]), start);
				}
			resolve(starts);
		});
	});
}

/** Fresh leases at each boundary; daemon identity resolution is lazy and scoped to one command. */
export function sessionHeldCheck(
	resolveDaemonPids?: (observedStarts: ReadonlyMap<number, number | undefined>) => Promise<readonly number[]>,
): (sessionFile: string | undefined, sessionId?: string) => Promise<void> {
	let daemonPids: Promise<readonly number[]> | undefined;
	let processStarts: Promise<ReadonlyMap<number, number>> | undefined;
	const observedStarts = new Map<number, number | undefined>();
	return async (sessionFile, sessionId) => {
		const holders = await foreignSessionHolders(sessionFile, sessionId, {
			readProcessStartMs: (pid) => {
				processStarts ??= readProcessStarts();
				return processStarts.then((starts) => {
					const start = starts.get(pid);
					observedStarts.set(pid, start);
					return start;
				});
			},
		});
		if (holders.length === 0) return;
		daemonPids ??= resolveDaemonPids?.(observedStarts) ?? Promise.resolve([]);
		const family = await daemonPids;
		const foreign = holders.filter((holder) => !family.includes(holder.pid));
		if (foreign.length > 0)
			throw new RpcSessionRegistryError(RPC_ERROR_SESSION_HELD, undefined, {
				holders: foreign.map(({ pid, cwd }) => ({ pid, ...(cwd === undefined ? {} : { cwd }) })),
			});
	};
}

/** The session-command admission boundary shared by in-process and worker hosts. */
export async function dispatchSessionBinding(
	command: RpcInboundRecord,
	entry: RpcSessionEntry,
	binding: RpcSessionBinding | undefined,
	acknowledgePrompt: () => void,
	daemonPids?: (observedStarts: ReadonlyMap<number, number | undefined>) => Promise<readonly number[]>,
): Promise<void> {
	if (!binding) throw new RpcSessionRegistryError("unknown_session");
	if (!READ_ONLY_OR_CONTROL.has(command.type)) {
		const assertSessionNotHeld = sessionHeldCheck(daemonPids);
		const state = entry.worker?.snapshot?.state;
		await assertSessionNotHeld(
			entry.runtime?.session.sessionFile ?? state?.sessionFile ?? entry.sessionPath,
			entry.runtime?.session.sessionId ?? state?.sessionId ?? entry.durableSessionId,
		);
		if ("sessionPath" in command) await assertSessionNotHeld(command.sessionPath);
	}
	if (command.type === "prompt") acknowledgePrompt();
	await binding.handle(command);
}
