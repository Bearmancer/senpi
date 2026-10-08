## 2026-10-07 - Lazy request setup preserves OAuth retry diagnostics (senpi#2893)

### What changed

- `packages/ai/src/api/lazy.ts`: attach the fixed OAuth-unavailable diagnostic with provider-only details when asynchronous authentication setup fails transiently.

### Why

The lazy stream converted the branded auth error into plain text, causing an immediate fallback instead of same-model recovery.

### Why an extension could not handle it

The lazy setup converter owns the assistant message before session retry hooks see it.

### Expected merge conflict zones

- `createSetupErrorMessage` in `lazy.ts`.

## 2026-10-08 - Mistral sends consecutive user turns as one user message (senpi#2920)

### What changed

- `packages/ai/src/api/mistral-conversations.ts`: `toChatMessages` appends every user turn through `appendUserMessage`, which merges it into the previous message when that message is also a user message (string content becomes a text chunk), as the OpenAI Chat converter does for non-OpenAI endpoints.

### Why

The coding agent now sends a blocking ask-user answer's own words as a user message right after the tool results, so a following steer or prompt produced two user messages in a row; Mistral's role-order rules are not documented to accept that.

### Why an extension could not handle it

The Mistral message mapping runs inside the provider adapter after every extension hook.

### Expected merge conflict zones

- LOW: the `msg.role === "user"` branch of `toChatMessages` and the new `appendUserMessage` helper above it in `mistral-conversations.ts`.
