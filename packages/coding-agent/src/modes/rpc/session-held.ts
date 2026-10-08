import { foreignSessionHolders } from "../../core/foreign-session-holders.ts";
import type { RpcCommand } from "./rpc-types.ts";
import { RPC_ERROR_SESSION_HELD } from "./rpc-types.ts";
import type { RpcSessionBinding } from "./session-binding.ts";
import { type RpcSessionEntry, RpcSessionRegistryError } from "./session-registry-types.ts";

// Admission is conservative: a new command must pass the guard unless it is explicitly
// a read or a control needed to finish/cancel an already-admitted turn.
const READ_ONLY_OR_CONTROL = new Set<RpcCommand["type"]>([
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
]);

/** Refuse before runtime creation, attach mutation, prompt acknowledgment, or binding delivery. */
export async function assertSessionNotHeld(
	sessionFile: string | undefined,
	sessionId?: string,
	daemonPids: readonly number[] = [],
): Promise<void> {
	const holders = (await foreignSessionHolders(sessionFile, sessionId)).filter(
		(holder) => !daemonPids.includes(holder.pid),
	);
	if (holders.length > 0)
		throw new RpcSessionRegistryError(RPC_ERROR_SESSION_HELD, undefined, {
			holders: holders.map(({ pid, cwd }) => ({ pid, ...(cwd === undefined ? {} : { cwd }) })),
		});
}

/** The session-command admission boundary shared by in-process and worker hosts. */
export async function dispatchSessionBinding(
	command: RpcCommand,
	entry: RpcSessionEntry,
	binding: RpcSessionBinding | undefined,
	acknowledgePrompt: () => void,
	daemonPids?: () => Promise<readonly number[]>,
): Promise<void> {
	if (!binding) throw new RpcSessionRegistryError("unknown_session");
	if (!READ_ONLY_OR_CONTROL.has(command.type)) {
		const state = entry.worker?.snapshot?.state;
		await assertSessionNotHeld(
			entry.runtime?.session.sessionFile ?? state?.sessionFile ?? entry.sessionPath,
			entry.runtime?.session.sessionId ?? state?.sessionId ?? entry.durableSessionId,
			await daemonPids?.(),
		);
		if ("sessionPath" in command) await assertSessionNotHeld(command.sessionPath, undefined, await daemonPids?.());
	}
	if (command.type === "prompt") acknowledgePrompt();
	await binding.handle(command);
}
