import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { sessionHolderWarning } from "../../core/foreign-session-holders.ts";
import { MissingSessionCwdError } from "../../core/session-cwd.ts";
import { formatTimings } from "../../core/timings.ts";

interface ResumeUI {
	readonly runtime: AgentSessionRuntime;
	readonly trust: NonNullable<Parameters<AgentSessionRuntime["switchSession"]>[1]>["projectTrustContextFactory"];
	readonly missingCwd: (error: MissingSessionCwdError) => Promise<string | undefined>;
	readonly status: (message: string) => void;
	readonly warning: (message: string) => void;
	readonly fatal: (message: string, cause: unknown) => Promise<{ cancelled: boolean }>;
}

/** In-session resume, including its missing-cwd retry and foreign-holder warning. */
export async function resumeInteractiveSession(
	ui: ResumeUI,
	sessionPath: string,
	options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
): Promise<{ cancelled: boolean }> {
	try {
		const warning = await sessionHolderWarning(sessionPath);
		if (warning !== undefined) ui.warning(warning);
		const result = await ui.runtime.switchSession(sessionPath, {
			withSession: options?.withSession,
			projectTrustContextFactory: ui.trust,
		});
		if (result.cancelled) return result;
		const switchTimings = formatTimings("switch");
		ui.status(switchTimings === undefined ? "Resumed session" : `Resumed session | switch timings: ${switchTimings}`);
		return result;
	} catch (cause) {
		if (!(cause instanceof MissingSessionCwdError)) return ui.fatal("Failed to resume session", cause);
		const cwdOverride = await ui.missingCwd(cause);
		if (!cwdOverride) {
			ui.status("Resume cancelled");
			return { cancelled: true };
		}
		const result = await ui.runtime.switchSession(sessionPath, {
			cwdOverride,
			withSession: options?.withSession,
			projectTrustContextFactory: ui.trust,
		});
		if (result.cancelled) return result;
		ui.status("Resumed session in current cwd");
		return result;
	}
}
