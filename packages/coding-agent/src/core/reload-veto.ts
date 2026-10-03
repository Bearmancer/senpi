import type { ExtensionRunner } from "./extensions/runner.ts";
import type { ReloadVetoDecision } from "./extensions/types.ts";

export async function checkSessionReloadVeto(
	runner: Pick<ExtensionRunner, "hasHandlers" | "emit">,
	isPromptStartPending: () => boolean,
): Promise<ReloadVetoDecision> {
	if (isPromptStartPending()) {
		return { cancelled: true, reason: "A prompt is being admitted." };
	}
	const result = runner.hasHandlers("session_before_reload")
		? await runner.emit({ type: "session_before_reload" })
		: undefined;
	if (isPromptStartPending()) {
		return { cancelled: true, reason: "A prompt is being admitted." };
	}
	if (result?.cancel !== true) return { cancelled: false };
	return result.reason === undefined ? { cancelled: true } : { cancelled: true, reason: result.reason };
}
