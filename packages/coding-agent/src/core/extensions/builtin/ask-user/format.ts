import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type AskUserVariant,
	DEFAULT_ASK_USER_TIMEOUT_MS,
	type QuestionRequest,
	type QuestionResponse,
} from "./schema.ts";

export type CodexResultDetails = {
	resolvedBy?: QuestionResponse["resolvedBy"];
	answers: Record<string, { answers: string[] }>;
	comment?: string;
	unanswered: string[];
	status: QuestionResponse["status"];
};

export type ClaudeResultDetails = {
	resolvedBy?: QuestionResponse["resolvedBy"];
	questions: QuestionRequest["questions"];
	answers: Record<string, string>;
	freeText?: string;
	unanswered: string[];
	status: QuestionResponse["status"];
	userText?: string[];
};

type Questions = QuestionRequest["questions"];
type Question = Questions[number];

/**
 * Where the user's own words go: inline for people (hooks, the transcript card), or out of the
 * model-facing text with a numbered reference, so they reach the model as a user turn and never
 * inside a tool result or beside a harness label (senpi#2920).
 */
interface UserWords {
	place(text: string): string;
}

const INLINE_WORDS: UserWords = { place: (text) => text };
const USER_TEXT_REFERENCE = /\(see the user's text (\d+) below\)/g;

function separateWords(): UserWords & { texts: string[] } {
	const texts: string[] = [];
	return {
		texts,
		place(text) {
			texts.push(text);
			return `(see the user's text ${texts.length} below)`;
		},
	};
}

function headerFor(id: string, questions: Questions): string {
	return questions.find((question) => question.id === id)?.header ?? id;
}

function questionTextFor(id: string, questions: Questions): string {
	return questions.find((question) => question.id === id)?.question ?? id;
}

function typedText(answer: { selected: string[]; text?: string }): string | undefined {
	if (answer.selected.length > 0) return undefined;
	const text = answer.text?.trim();
	return text === undefined || text.length === 0 ? undefined : text;
}

/** A typed text that repeats an offered label (clients that report picks as text) is not the user's own words. */
function answerBody(
	answer: { selected: string[]; text?: string } | undefined,
	words: UserWords = INLINE_WORDS,
	offered: Question["options"] = [],
): string | undefined {
	if (!answer) return undefined;
	if (answer.selected.length > 0) return answer.selected.join(", ");
	const text = typedText(answer);
	if (text === undefined) return undefined;
	return offered.some((option) => option.label === text) ? text : words.place(text);
}

function answeredLines(response: QuestionResponse, questions: Questions, words: UserWords): string[] {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const question of questions) {
		const body = answerBody(response.answers[question.id], words, question.options);
		if (body !== undefined) {
			lines.push(`${question.header}: ${body}`);
			seen.add(question.id);
		}
	}
	for (const [id, answer] of Object.entries(response.answers)) {
		if (seen.has(id)) continue;
		const body = answerBody(answer, words);
		if (body !== undefined) lines.push(`${headerFor(id, questions)}: ${body}`);
	}
	return lines;
}

function formatBody(response: QuestionResponse, questions: Questions, words: UserWords): string {
	switch (response.status) {
		case "answered": {
			const lines = answeredLines(response, questions, words);
			const unanswered = response.unanswered.map((id) => headerFor(id, questions));
			if (unanswered.length > 0) lines.push(`Unanswered: ${unanswered.join(", ")}`);
			return lines.join("\n");
		}
		case "comment-submitted": {
			const comment = response.comment?.trim() ?? "";
			const lines = [
				`The user responded: ${comment.length > 0 ? words.place(comment) : ""}`,
				...answeredLines(response, questions, words),
			];
			const unanswered = response.unanswered.map((id) => headerFor(id, questions));
			if (unanswered.length > 0) lines.push(`Unanswered: ${unanswered.join(", ")}`);
			return lines.join("\n");
		}
		case "timed_out": {
			const minutes = Math.round((response.autoResolvedAfterMs ?? DEFAULT_ASK_USER_TIMEOUT_MS) / 60_000);
			const lines = [
				`The user did not answer within ${minutes} minutes. (사용자가 답변을 안하고 timeout 으로 종료됨)`,
			];
			const selected = answeredLines(response, questions, words);
			if (selected.length > 0) {
				lines.push(`Before going idle the user had selected: ${selected.join("; ")}`);
			}
			lines.push("Continue the work to completion on your best judgment; do not ask this question again this turn.");
			return lines.join("\n");
		}
		case "cancelled":
			return "The user dismissed the question.";
		case "orphaned-after-restart":
			return "The pending question could not be resumed after a restart; continue on best judgment.";
		case "unavailable":
			return "This session has no user attached (subagent or headless); decide on best judgment.";
	}
}

/** The answer as a person reads it, with the user's words inline (hooks, the transcript card). */
export function formatResultText(
	_variant: AskUserVariant,
	response: QuestionResponse,
	questions: Questions = [],
): string {
	return formatBody(response, questions, INLINE_WORDS);
}

/**
 * The answer as the model receives it: `text` holds only the structure and the options the model
 * offered, and each of the user's own words (comment, typed answers) is a `userText` entry that
 * `text` refers to by number and that travels as its own user text block.
 */
export function formatModelAnswer(
	response: QuestionResponse,
	questions: Questions = [],
): { text: string; userText: string[] } {
	const words = separateWords();
	const text = formatBody(response, questions, words);
	return { text, userText: words.texts };
}

/** Restores the user's words in place of their numbered references, for display. */
export function resolveUserTextReferences(text: string, userText: readonly string[]): string {
	return text.replace(USER_TEXT_REFERENCE, (reference, index: string) => userText[Number(index) - 1] ?? reference);
}

/**
 * The framed user message for a later answer. The `[Answer to question <id>]` label and the
 * structure share the first block; each of the user's words is a block of its own after it. An
 * answer with no typed words stays the single framed string it always was.
 */
export function formatUserMessage(
	response: QuestionResponse,
	requestId: string,
	questions: Questions = [],
): string | TextContent[] {
	const answer = formatModelAnswer(response, questions);
	const frame = `[Answer to question ${requestId}]\n${answer.text}`;
	if (answer.userText.length === 0) return frame;
	return [frame, ...answer.userText].map((text) => ({ type: "text" as const, text }));
}

/** Display text of a framed answer whose words travel as separate blocks; undefined otherwise. */
export function askUserAnswerDisplayText(content: string | (TextContent | ImageContent)[]): string | undefined {
	if (typeof content === "string") return undefined;
	const [frame, ...words] = content.flatMap((block) => (block.type === "text" ? [block.text] : []));
	if (frame === undefined || words.length === 0 || !parseAskUserAnswerFrame(frame)) return undefined;
	return resolveUserTextReferences(frame, words);
}

export interface AskUserAnswerFrame {
	readonly requestId: string;
	readonly body: string;
}

export function parseAskUserAnswerFrame(text: string): AskUserAnswerFrame | undefined {
	const match = /^\[Answer to question ([^\]\r\n]+)\]\r?\n([\s\S]*)$/.exec(text);
	return match ? { requestId: match[1], body: match[2] } : undefined;
}

function selectedAnswers(answer: { selected: string[]; text?: string }): string[] {
	if (answer.selected.length > 0) return answer.selected;
	const text = answer.text?.trim();
	return text === undefined || text.length === 0 ? [] : [text];
}

export function formatResultDetails(
	variant: AskUserVariant,
	response: QuestionResponse,
	questions: Questions = [],
): CodexResultDetails | ClaudeResultDetails {
	const { userText } = formatModelAnswer(response, questions);
	if (variant === "codex") {
		const answers: CodexResultDetails["answers"] = {};
		for (const [id, answer] of Object.entries(response.answers)) {
			answers[id] = { answers: selectedAnswers(answer) };
		}
		const details: CodexResultDetails = {
			...(response.resolvedBy !== undefined ? { resolvedBy: response.resolvedBy } : {}),
			answers,
			unanswered: response.unanswered,
			status: response.status,
		};
		if (response.comment !== undefined) details.comment = response.comment;
		if (userText.length > 0) details.userText = userText;
		return details;
	}
	const answers: Record<string, string> = {};
	for (const [id, answer] of Object.entries(response.answers)) {
		const body = answerBody(answer);
		if (body !== undefined) answers[questionTextFor(id, questions)] = body;
	}
	const details: ClaudeResultDetails = {
		...(response.resolvedBy !== undefined ? { resolvedBy: response.resolvedBy } : {}),
		questions,
		answers,
		unanswered: response.unanswered.map((id) => questionTextFor(id, questions)),
		status: response.status,
	};
	if (response.comment !== undefined) details.freeText = response.comment;
	if (userText.length > 0) details.userText = userText;
	return details;
}
