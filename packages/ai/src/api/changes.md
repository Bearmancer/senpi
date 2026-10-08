## 2026-10-08 - Sol Ultrafast uses published sixfold pricing (senpi#2975)

### What changed

- `packages/ai/src/api/openai-responses.ts` and `packages/ai/src/api/openai-codex-responses.ts`: Ultrafast estimated costs apply the published 6x Standard multiplier to GPT-6.1 Sol as well as GPT-6 Astra. The pricing lookup uses `upstreamModelId ?? id`, covering pinned aliases while leaving the wire request unchanged.

### Why

- [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing) now lists Sol Ultrafast at $12/$0.60/$15/$60 per million input/cached-input/cache-write/output tokens, and $24/$1.20/$30/$90 for long context. Both tables are 6x Standard. Matching only the catalog id undercounted the native alias by sixfold.

### Why an extension could not handle it

- Both adapters calculate streamed usage costs internally after response processing.

### Expected merge conflict zones

- LOW: `getServiceTierCostMultiplier` and `applyServiceTierPricing` in both adapters.

## 2026-10-08 - A configured anthropic-beta header is merged with the betas the request body needs (senpi#2957)

### What changed

- `packages/ai/src/api/anthropic-messages.ts` `getBetaFeatures`: a configured `anthropic-beta` header (model `headers` or per-request `options.headers`) used to replace the whole computed beta list. It now owns only the optional betas, and the betas the request body depends on are appended to it, de-duplicated, configured order first. Those betas come from the request shape `buildParams` decided (`BetaDependentShape`):
  - OAuth identity;
  - mid-conversation effort markers, plus thinking binding when thinking is on;
  - native tool changes;
  - `fallbacks` in the body (`server-side-fallback-2026-07-01`, which a configured header also dropped before).

  Interleaved thinking is stripped from a configured list on adaptive models, as it already was from the client headers.
- `buildParams`: `anthropic-beta: null` makes the request take a shape that needs no beta:
  - the current tool list instead of native tool changes;
  - top-level effort instead of per-message effort markers and `block_binding`;
  - no `fallbacks`.

  The client-level fallback beta follows the same rule. Only an OAuth token, whose credential depends on its identity betas, still fails, before sending, with an error that names them.

### Why

A proxy route that sets its own `anthropic-beta` header dropped `mid-conversation-output-config-2026-07-01` while senpi still sent the mid-conversation effort message. Claude Haiku, Opus and Sonnet 5.5 then failed the first request with `400 messages.1.output_config: Extra inputs are not permitted`. A `null` header must keep working: a request it would otherwise invalidate switches shape instead of failing.

### Why an extension could not handle it

The beta list and the request shape are assembled inside the provider's request builder, after every extension hook has run.

### Expected merge conflict zones

- `getBetaFeatures` (with `configuredBetaHeader`, `defaultOptionalBetas`) and the `nativeToolChanges` / effort / `fallbacks` decisions in `buildParams`.

## 2026-10-08 - Claude Haiku 5.5 joins the adaptive-only families (senpi#2892)

### What changed

- `packages/ai/src/api/anthropic-messages.ts`: `ADAPTIVE_THINKING_MODEL_MARKERS` and `NATIVE_XHIGH_EFFORT_MODEL_MARKERS` gain `haiku-5-5`, and `DISABLED_THINKING_REJECTING_MODEL_MARKERS` gains `haiku-5-5` / `haiku-5.5`, so a Haiku 5.5 row without generated compat (a `models.json` entry, a gateway row) sends adaptive thinking with an effort instead of `budget_tokens` and pins effort `low` for a thinking-off turn instead of `thinking.type: "disabled"`.
- `packages/ai/src/api/anthropic-messages.ts`: the `DISABLED_THINKING_REJECTING_MODEL_MARKERS` comment says which entries the live 400 verified (Fable 5, Opus 5.5, Sonnet 5.5), and that Haiku 5.5 is listed by choice: its docs accept `disabled` at effort `high` or below, and a real thinking-off is senpi#2927.
- `packages/ai/src/api/anthropic-messages.ts`: the managed-effort branch comment no longer claims these families accept `thinking.type: "disabled"`; it names `disableThinkingForRequest` as the thinking-off path.
- `packages/ai/src/api/bedrock-converse-stream.ts`: `supportsAdaptiveThinking`, `supportsNativeXhighEffort` and `rejectsDisabledThinking` match `haiku-5-5` (and the dotted spelling for the last), for the same reason on Bedrock Converse.

### Why

Claude Haiku 5.5 rejects `thinking: {type: "enabled", budget_tokens}` (400) and documents only an unset or adaptive `thinking` with `output_config.effort` low..max. It accepts forced `tool_choice`, so `FORCED_TOOL_CHOICE_REJECTING_MODEL_ID` in `utils/prompt-cache-ttl.ts` deliberately stays unchanged.

### Why an extension could not handle it

The family marker lists are private to the API adapters.

### Expected merge conflict zones

- The three marker arrays in `anthropic-messages.ts`; the three family predicates in `bedrock-converse-stream.ts`.

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

## 2026-10-08 - Mistral sends consecutive user turns as one user message (senpi#2920)

### What changed

- `packages/ai/src/api/mistral-conversations.ts`: `toChatMessages` appends every user turn through `appendUserMessage`, which merges it into the previous message when that message is also a user message (string content becomes a text chunk), as the OpenAI Chat converter does for non-OpenAI endpoints.

### Why

The coding agent now sends a blocking ask-user answer's own words as a user message right after the tool results, so a following steer or prompt produced two user messages in a row; Mistral's role-order rules are not documented to accept that.

### Why an extension could not handle it

The Mistral message mapping runs inside the provider adapter after every extension hook.

### Expected merge conflict zones

- LOW: the `msg.role === "user"` branch of `toChatMessages` and the new `appendUserMessage` helper above it in `mistral-conversations.ts`.
