import { evaluate } from "../permission-system/evaluate.ts";
import type { ReplyInput, Request, Rule, Ruleset } from "../permission-system/types.ts";

export interface NoUIOptions {
	readonly staticRuleset: Ruleset;
	readonly cliOverride: Ruleset;
	readonly emitEvent: (event: string, data: unknown) => void;
	/** The `auto` preset is active: the service already combined every rule and still asks. */
	readonly presetBound?: boolean;
}

/**
 * Handle permission request in no-UI mode (print mode, unbound SDK).
 * Returns ReplyInput to reject, or undefined to allow.
 *
 * Every pattern of the request is judged, CLI override before the static ruleset; the request is
 * allowed only when every pattern is allowed, and any denied pattern rejects it. With `presetBound`
 * the service's ask stands, so the request is refused: no configured allow can widen `auto`.
 */
export function handleNoUI(request: Request, options: NoUIOptions): ReplyInput | undefined {
	const { staticRuleset, cliOverride, emitEvent, presetBound = false } = options;
	// Emit permission_asked event for logging/telemetry
	emitEvent("permission_asked", request);
	const patternsStr = request.patterns.join(", ");

	if (presetBound) {
		return {
			requestID: request.id,
			reply: "reject",
			message: `Permission required for ${request.permission} (${patternsStr}), and there is no UI to ask. Under the auto preset, allow rules do not widen what it approves; run it interactively or choose another preset.`,
		};
	}

	const decisions = request.patterns.map((pattern) => decideWithoutUI(request.permission, pattern, options));
	const denied = decisions.find((decision) => decision.action === "deny");
	if (denied) {
		return {
			requestID: request.id,
			reply: "reject",
			message: `Permission denied by ${denied.source}: ${request.permission}`,
		};
	}
	if (decisions.length > 0 && decisions.every((decision) => decision.action === "allow")) {
		emitEvent("permission_replied", { requestID: request.id, sessionID: request.sessionID, reply: "allow" });
		return undefined;
	}

	// Still "ask" for at least one pattern - auto-deny with helpful message
	return {
		requestID: request.id,
		reply: "reject",
		message: `Permission required for ${request.permission} (${patternsStr}). Use --permission ${request.permission}=allow to override.`,
	};
}

function decideWithoutUI(
	permission: string,
	pattern: string,
	{ cliOverride, staticRuleset }: NoUIOptions,
): { readonly action: Rule["action"]; readonly source: "CLI flag" | "config" } {
	const cliRule = evaluate(permission, pattern, cliOverride);
	if (cliRule.action !== "ask") return { action: cliRule.action, source: "CLI flag" };
	return { action: evaluate(permission, pattern, staticRuleset).action, source: "config" };
}
