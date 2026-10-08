## 2026-10-08 - Claude Haiku 5.5 joins the adaptive-only families (senpi#2892)

### What changed

- `packages/ai/src/api/anthropic-messages.ts`: `ADAPTIVE_THINKING_MODEL_MARKERS` and `NATIVE_XHIGH_EFFORT_MODEL_MARKERS` gain `haiku-5-5`, and `DISABLED_THINKING_REJECTING_MODEL_MARKERS` gains `haiku-5-5` / `haiku-5.5`, so a Haiku 5.5 row without generated compat (a `models.json` entry, a gateway row) sends adaptive thinking with an effort instead of `budget_tokens` and pins effort `low` for a thinking-off turn instead of `thinking.type: "disabled"`.
- `packages/ai/src/api/bedrock-converse-stream.ts`: `supportsAdaptiveThinking`, `supportsNativeXhighEffort` and `rejectsDisabledThinking` match `haiku-5-5` (and the dotted spelling for the last), for the same reason on Bedrock Converse.

### Why

Claude Haiku 5.5 rejects `thinking: {type: "enabled", budget_tokens}` (400) and documents only an unset or adaptive `thinking` with `output_config.effort` low..max. It accepts forced `tool_choice`, so `FORCED_TOOL_CHOICE_REJECTING_MODEL_ID` in `utils/prompt-cache-ttl.ts` deliberately stays unchanged.

### Why an extension could not handle it

The family marker lists are private to the API adapters.

### Expected merge conflict zones

- The three marker arrays in `anthropic-messages.ts`; the three family predicates in `bedrock-converse-stream.ts`.

## 2026-10-07 - Lazy request setup preserves OAuth retry diagnostics (senpi#2893)

### What changed

- `packages/ai/src/api/lazy.ts`: attach the fixed OAuth-unavailable diagnostic with provider-only details when asynchronous authentication setup fails transiently.

### Why

The lazy stream converted the branded auth error into plain text, causing an immediate fallback instead of same-model recovery.

### Why an extension could not handle it

The lazy setup converter owns the assistant message before session retry hooks see it.

### Expected merge conflict zones

- `createSetupErrorMessage` in `lazy.ts`.
