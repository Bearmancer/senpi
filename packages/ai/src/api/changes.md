## 2026-10-08 - Per-message Anthropic effort reaches the wire (senpi#2912)

### What changed

- `packages/ai/src/api/anthropic-tool-references.ts`: `demoteUnavailableToolReferences` drops a message only when the demotion itself emptied it. A message that arrived with `content: []` (the per-message effort marker) passes through untouched. Side effect: a non-marker empty message (one an `onPayload` hook adds; `convertMessages` never produces one) now also reaches the API instead of being dropped silently.
- `packages/ai/src/api/anthropic-tool-references.ts`: the all-references-gone decision for a native search pair is collected over the whole request instead of per message. A pair can span two assistant messages (a deferred server tool resumes in the continuation), and the `server_tool_use` left alone in the earlier message was kept while its result was demoted to text, an unpaired use. Now it is dropped too, and the message it emptied is removed. That is the only rewrite that empties a message.
- `packages/ai/src/api/anthropic-messages.ts`: `managedEffortForRequest` decides the effort of a per-message-effort request once, for both the active marker (`buildParams`) and the recorded `providerThinkingLevel` (`stream`). That is the caller's effort with thinking on, `low` for a thinking-off turn on a family that cannot disable thinking, and none when thinking is disabled. `disableThinkingForRequest` removes every effort marker when it emits `thinking: { type: "disabled" }` (the same rule as senpi#1399).

### Why

The demotion pass (5ecb30463) dropped every message whose rebuilt content was empty. Per-message effort markers (4e69b0c28) are deliberately content-less, so every marker was deleted after `onPayload`, and every catalog row with per-message effort (Opus 5 / 5.5, Sonnet 5.5, Fable 5.1) always ran at the top-level effort `high`. Once the markers reach the wire, a thinking-off turn must not carry a contradicting marker: the active marker said `high` beside the pinned top-level `low`, and historical markers beside `thinking.type: "disabled"` are a 400.

### Why an extension could not handle it

Both passes run inside the provider's request pipeline after every extension hook (`onPayload`).

### Expected merge conflict zones

- `demoteUnavailableToolReferences`'s empty-message check in `anthropic-tool-references.ts`.
- `disableThinkingForRequest`, the `providerThinkingLevel` line in `stream` and the `activeEffort` line in `buildParams` in `anthropic-messages.ts`.

## 2026-10-07 - Lazy request setup preserves OAuth retry diagnostics (senpi#2893)

### What changed

- `packages/ai/src/api/lazy.ts`: attach the fixed OAuth-unavailable diagnostic with provider-only details when asynchronous authentication setup fails transiently.

### Why

The lazy stream converted the branded auth error into plain text, causing an immediate fallback instead of same-model recovery.

### Why an extension could not handle it

The lazy setup converter owns the assistant message before session retry hooks see it.

### Expected merge conflict zones

- `createSetupErrorMessage` in `lazy.ts`.
