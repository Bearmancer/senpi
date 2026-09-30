import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
} from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import type { EditorSubmitDetails } from "../src/editor-component.ts";
import { getSlashCommandSuggestions } from "../src/slash-command-autocomplete.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// omo #9042 A: Enter on a picker row whose command declares an argument hint completes `/name `
// and waits for the arguments; a row without a hint still submits in one press.
const COMMANDS = [
	{ name: "new", description: "Start a new session" },
	{ name: "skill:ulw-execute", description: "Execute a plan", argumentHint: "<plan>" },
];

// Hands each suggestion result to the test in order, so it can await the editor's own requests
// instead of sleeping.
function recordingProvider(): {
	provider: AutocompleteProvider;
	nextSuggestions(label: string): Promise<AutocompleteSuggestions | null>;
} {
	const base = new CombinedAutocompleteProvider(COMMANDS, "/tmp");
	const settled: (AutocompleteSuggestions | null)[] = [];
	const waiters: ((value: AutocompleteSuggestions | null) => void)[] = [];
	const provider: AutocompleteProvider = {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const result = await base.getSuggestions(lines, cursorLine, cursorCol, options);
			const waiter = waiters.shift();
			if (waiter) waiter(result);
			else settled.push(result);
			return result;
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			base.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
	};
	const nextSuggestions = (label: string) => {
		const ready = settled.shift();
		const next =
			ready !== undefined
				? Promise.resolve(ready)
				: new Promise<AutocompleteSuggestions | null>((resolve) => waiters.push(resolve));
		return Promise.race([
			next,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error(`editor never requested suggestions: ${label}`)), 2000);
			}),
		]);
	};
	return { provider, nextSuggestions };
}

async function openPicker(typed: string, expectedFirst: string) {
	const { provider, nextSuggestions } = recordingProvider();
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
	editor.setAutocompleteProvider(provider);
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	editor.handleInput(typed);
	for (;;) {
		const suggestions = await nextSuggestions(`typing ${typed}`);
		if (suggestions?.items[0]?.value === expectedFirst) break;
	}
	await Promise.resolve();
	assert.strictEqual(editor.isShowingAutocomplete(), true);
	return { editor, submitted };
}

describe("Editor slash rows with an argument hint", () => {
	it("marks only hinted commands as awaiting arguments", () => {
		const items = getSlashCommandSuggestions(COMMANDS, "skill:");
		const byValue = new Map(items.map((item) => [item.value, item.awaitsArguments]));
		assert.strictEqual(byValue.get("skill:ulw-execute"), true);
		assert.strictEqual(getSlashCommandSuggestions(COMMANDS, "ne")[0]?.awaitsArguments, undefined);
	});

	it("Enter on a hinted row completes the command and waits for arguments", async () => {
		const { editor, submitted } = await openPicker("/ulw", "skill:ulw-execute");

		editor.handleInput("\r");

		assert.deepStrictEqual(submitted, []);
		assert.strictEqual(editor.getText(), "/skill:ulw-execute ");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: "/skill:ulw-execute ".length });
		assert.strictEqual(editor.isShowingAutocomplete(), false);
	});

	it("a second Enter submits the completed hinted command", async () => {
		const { editor, submitted } = await openPicker("/ulw", "skill:ulw-execute");

		editor.handleInput("\r");
		editor.handleInput("\r");

		assert.deepStrictEqual(submitted, ["/skill:ulw-execute"]);
	});

	it("Enter on a row without a hint still submits in one press", async () => {
		const { editor, submitted } = await openPicker("/ne", "new");

		editor.handleInput("\r");

		assert.deepStrictEqual(submitted, ["/new"]);
	});
});

describe("Editor submit details", () => {
	it("reports the untrimmed text next to the trimmed submission", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		const submissions: [string, EditorSubmitDetails | undefined][] = [];
		editor.onSubmit = (text, details) => submissions.push([text, details]);

		editor.setText(" /foo bar");
		editor.handleInput("\r");

		assert.deepStrictEqual(submissions, [["/foo bar", { rawText: " /foo bar" }]]);
	});
});
