import type { RpcExtensionUIResponse } from "./rpc-types.ts";

/**
 * An `extension_ui_response` carries two ids: `id`, the frame's own correlation id that its reply
 * echoes, and `uiRequestId`, the extension UI request it answers. The short form every older client
 * sends has no `uiRequestId`; its `id` names both. Hosts and terminal control endpoints read it here.
 */
export function answeredUiRequestId(frame: {
	readonly id?: unknown;
	readonly uiRequestId?: unknown;
}): string | undefined {
	if (typeof frame.uiRequestId === "string") return frame.uiRequestId;
	return typeof frame.id === "string" ? frame.id : undefined;
}

export type ExtensionUiResponseReply = {
	readonly id: string;
	readonly type: "response";
	readonly command: "extension_ui_response";
} & ({ readonly success: true } | { readonly success: false; readonly error: string });

type QuestionAnswers = {
	respond(response: RpcExtensionUIResponse): boolean | "question_incomplete" | "question_already_resolved";
};
type DialogAnswers = { resolve(response: RpcExtensionUIResponse): boolean };

/**
 * Settles one response on a host connection and returns its reply, keyed by the frame `id`.
 * `undefined` only on an unrouted (single-session stdio) connection for a response no request here
 * matches: that connection has always ignored such a response, and still does.
 */
export function settleExtensionUiResponse(
	response: RpcExtensionUIResponse,
	targets: { readonly questions: QuestionAnswers; readonly dialogs: DialogAnswers; readonly routed: boolean },
): ExtensionUiResponseReply | undefined {
	const requestId = answeredUiRequestId(response) ?? response.id;
	const answer = requestId === response.id ? response : { ...response, id: requestId };
	const question = targets.questions.respond(answer);
	if (typeof question === "string") return refused(response.id, question);
	if (question || targets.dialogs.resolve(answer)) return { ...reply(response.id), success: true };
	// A routed binding owns exactly one session's request map: an unmatched response is a protocol
	// error for its sender, never a cross-session match.
	return targets.routed ? refused(response.id, "unknown_extension_ui_request") : undefined;
}

function reply(id: string) {
	return { id, type: "response", command: "extension_ui_response" } as const;
}

function refused(id: string, error: string): ExtensionUiResponseReply {
	return { ...reply(id), success: false, error };
}
