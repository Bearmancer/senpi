import chalk from "chalk";
import { sessionHolderWarning } from "../core/foreign-session-holders.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SessionManager } from "../core/session-manager.ts";
import { normalizeSessionName } from "./args.ts";

/** Finish startup selection before any naming write or runtime construction. */
export async function prepareSessionOpening(
	manager: SessionManager,
	mode: AppMode,
	requestedName?: string,
): Promise<void> {
	if (mode === "interactive") {
		const warning = await sessionHolderWarning(manager.getSessionFile(), manager.getSessionId());
		if (warning !== undefined) console.error(chalk.yellow(`Warning: ${warning}`));
	}
	if (requestedName !== undefined) {
		const name = normalizeSessionName(requestedName);
		if (name === undefined) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		manager.appendSessionInfo(name);
	}
}
