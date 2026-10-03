/**
 * Splits a shell command into the simple commands the `auto` preset can judge one by one.
 *
 * The split fails closed: anything whose effect the judge cannot read from the words alone
 * (command or process substitution, variable expansion, escapes, grouping, subshells, input
 * redirection, here-docs, background jobs, comments, or output redirected anywhere except
 * /dev/null) returns undefined, and the caller asks the user.
 */
export interface ShellWord {
	readonly text: string;
	readonly hasGlob: boolean;
}

export type ShellSegment = readonly ShellWord[];

const GLOB_CHARACTERS = new Set(["*", "?", "["]);
const UNJUDGEABLE_UNQUOTED = new Set(["$", "`", "\\", "(", ")", "{", "}", "<", "#", "!"]);
const DEV_NULL = "/dev/null";

export function splitShellSegments(command: string): ShellSegment[] | undefined {
	const segments: ShellWord[][] = [];
	let words: ShellWord[] = [];
	let text = "";
	let hasGlob = false;
	let started = false;
	let operatorPending = false;

	const endWord = () => {
		if (started) words.push({ text, hasGlob });
		text = "";
		hasGlob = false;
		started = false;
	};
	const endSegment = (joinedByOperator: boolean): boolean => {
		endWord();
		if (words.length === 0) return !joinedByOperator && !operatorPending;
		segments.push(words);
		words = [];
		operatorPending = joinedByOperator;
		return true;
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (char === "'" || char === '"') {
			const close = command.indexOf(char, index + 1);
			if (close < 0) return undefined;
			const quoted = command.slice(index + 1, close);
			if (char === '"' && /[$`\\!]/.test(quoted)) return undefined;
			text += quoted;
			started = true;
			index = close;
			continue;
		}
		if (char === " " || char === "\t") {
			endWord();
			continue;
		}
		if (char === "\n" || char === "\r" || char === ";") {
			if (!endSegment(false)) return undefined;
			continue;
		}
		if (char === "&") {
			if (command[index + 1] === "&") {
				if (!endSegment(true)) return undefined;
				index += 1;
				continue;
			}
			if (command[index + 1] === ">" && !started) {
				const consumed = consumeDevNullTarget(command, index + 2);
				if (consumed === undefined) return undefined;
				index = consumed - 1;
				continue;
			}
			return undefined;
		}
		if (char === "|") {
			if (!endSegment(true)) return undefined;
			if (command[index + 1] === "|" || command[index + 1] === "&") index += 1;
			continue;
		}
		if (char === ">") {
			if (started && text !== "1" && text !== "2") return undefined;
			text = "";
			started = false;
			let next = index + 1;
			if (command[next] === ">") next += 1;
			if (command[next] === "&" && (command[next + 1] === "1" || command[next + 1] === "2")) {
				const after = command[next + 2];
				if (after !== undefined && !/[\s;|&]/.test(after)) return undefined;
				index = next + 1;
				continue;
			}
			const consumed = consumeDevNullTarget(command, next);
			if (consumed === undefined) return undefined;
			index = consumed - 1;
			continue;
		}
		if (UNJUDGEABLE_UNQUOTED.has(char)) return undefined;
		if (char === "~" && (!started || text.endsWith("=") || text.endsWith(":"))) return undefined;
		if (GLOB_CHARACTERS.has(char)) hasGlob = true;
		text += char;
		started = true;
	}

	endWord();
	if (words.length > 0) {
		segments.push(words);
		return segments;
	}
	return operatorPending ? undefined : segments;
}

function consumeDevNullTarget(command: string, start: number): number | undefined {
	let index = start;
	while (command[index] === " " || command[index] === "\t") index += 1;
	if (command.slice(index, index + DEV_NULL.length) !== DEV_NULL) return undefined;
	const after = command[index + DEV_NULL.length];
	if (after !== undefined && !/[\s;|&]/.test(after)) return undefined;
	return index + DEV_NULL.length;
}
