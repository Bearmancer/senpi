import type { ExtensionAPI } from "../../types.ts";
import { formatModelAnswer } from "./format.ts";
import { ASK_USER_ANSWER_MESSAGE } from "./notify.ts";
import type { QuestionRequest, QuestionResponse } from "./schema.ts";

/**
 * A blocking answer's own words (comment, typed answers) reach the model as a user turn steered
 * right after this call's tool result, never inside it: a model trained to distrust tool results
 * may ignore user text there (senpi#2920). The steering queue drains after the tool batch, so
 * every provider serializes the words after the batch's tool results, as it does typed steering.
 */
export function steerUserText(pi: Pick<ExtensionAPI, "sendMessage">, response: QuestionResponse, request: QuestionRequest) {
	const { userText } = formatModelAnswer(response, request.questions);
	if (userText.length === 0) return;
	pi.sendMessage(
		{
			customType: ASK_USER_ANSWER_MESSAGE,
			content: userText.map((text) => ({ type: "text" as const, text })),
			display: false,
			details: { requestId: request.requestId },
		},
		{ deliverAs: "steer" },
	);
}
