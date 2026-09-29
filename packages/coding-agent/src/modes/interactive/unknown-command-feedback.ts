import type { EditorSubmitDetails } from "@earendil-works/pi-tui";
import { UnknownCommandError } from "../../core/unknown-command.ts";

/** A `/...` submission typed after leading whitespace is sent as text instead of checked as a command. */
export function submitsCommandAsText(text: string, details: EditorSubmitDetails | undefined): boolean {
	return text.startsWith("/") && details !== undefined && /^\s/.test(details.rawText);
}

export interface UnknownCommandFeedbackTarget {
	readonly editor: { getText(): string; setText(text: string): void };
	showWarning(message: string): void;
}

/**
 * Turn an unknown-command rejection into editor feedback: the submitted text goes back into an empty
 * editor and the rejection message is shown as a warning. Returns `false` for any other error.
 */
export function reportUnknownCommand(
	error: unknown,
	submittedText: string,
	target: UnknownCommandFeedbackTarget,
): boolean {
	if (!(error instanceof UnknownCommandError)) return false;
	if (target.editor.getText().trim() === "") target.editor.setText(submittedText);
	target.showWarning(error.message);
	return true;
}
