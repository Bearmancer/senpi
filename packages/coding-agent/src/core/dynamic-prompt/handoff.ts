export interface HandoffSectionOptions {
	/**
	 * The caller's core already states a text-only turn-end rule ("check your last paragraph"),
	 * so the block drops its own "a Next with nothing after it is a defect" clause instead of
	 * stating that rule twice.
	 */
	turnEndRuleStatedElsewhere?: boolean;
	/**
	 * The model under-reports during long tool chains by default (Claude Fable 5.1 guide, "Ask for
	 * user-facing progress updates": remove narration-suppressing lines, then say when updates are
	 * wanted), so the quiet-between-handoffs sentence becomes a brief-update sentence.
	 */
	briefUpdatesBetweenHandoffs?: boolean;
}

export function buildHandoffSection(options: HandoffSectionOptions = {}): string {
	const nextRule = options.turnEndRuleStatedElsewhere
		? "The Next you name is executed in this same response with tool calls."
		: "The Next you name is executed in this same response with tool calls; a Next with nothing after it is a defect.";
	const betweenRule = options.briefUpdatesBetweenHandoffs
		? "Between handoffs, a one-line update on what you just found, ending with `Now: [task]. Next: [task].`, helps the user follow along."
		: "Between handoffs, work without narration.";
	return `## Handoff

A handoff is the todo list's creation (in the message that creates it, after the routing line, or the next one), each todo phase change, a blocker or plan change, and the final message; the routing line is not one. Before writing one, weigh what the user originally asked for and what they would want to know right now; then state it in one short block:

> Ask: [the user's original request] - wanted: [the outcome they asked for]. For you: [what they need to know now - ledger N/M done, findings, blockers]. Now: [the todo task in progress]. Next: [the next open task].

Now and Next are the todo labels verbatim. ${nextRule} ${betweenRule}`;
}
