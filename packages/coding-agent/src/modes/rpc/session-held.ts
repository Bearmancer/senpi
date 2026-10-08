import { foreignSessionHolders } from "../../core/foreign-session-holders.ts";
import type { RpcCommand } from "./rpc-types.ts";
import { RPC_ERROR_SESSION_HELD } from "./rpc-types.ts";
import type { RpcSessionBinding } from "./session-binding.ts";
import { type RpcSessionEntry, RpcSessionRegistryError } from "./session-registry-types.ts";

/** Refuse before runtime creation, attach mutation, prompt acknowledgment, or binding delivery. */
export async function assertSessionNotHeld(sessionFile: string | undefined, sessionId?: string): Promise<void> {
	const holders = await foreignSessionHolders(sessionFile, sessionId);
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
): Promise<void> {
	if (!binding) throw new RpcSessionRegistryError("unknown_session");
	if (command.type === "prompt" || command.type === "steer") {
		const state = entry.worker?.snapshot?.state;
		await assertSessionNotHeld(
			entry.runtime?.session.sessionFile ?? state?.sessionFile ?? entry.sessionPath,
			entry.runtime?.session.sessionId ?? state?.sessionId ?? entry.durableSessionId,
		);
	}
	if (command.type === "prompt") acknowledgePrompt();
	await binding.handle(command);
}
