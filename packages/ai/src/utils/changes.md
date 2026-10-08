## 2026-10-08 - Haiku 5.5 stays off for tool_reference loading until verified (senpi#2892, senpi#2914)

### What changed

- `packages/ai/src/utils/prompt-cache-ttl.ts`: the `defaultSupportsToolReferences` doc comment names Claude Haiku 5.5 as listed in Anthropic's tool-search table but kept off (the existing `haiku` exclusion) until a live probe; no behavior change.

### Why

The same table lists Haiku 4.5, which rejects client-side `tool_reference` blocks (#6474), and a rejection other than `Tool reference '…' not found` would fail the turn with no automatic demotion. senpi#2914 tracks the probe and the enable.

### Why an extension could not handle it

The `supportsToolReferences` default lives in the provider compat matrix.

### Expected merge conflict zones

- The `defaultSupportsToolReferences` doc comment in `prompt-cache-ttl.ts`.

## 2026-10-07 - Structured OAuth refresh retry facts (senpi#2893)

### What changed

- `packages/ai/src/utils/oauth-refresh-error.ts`: shared HTTP error, cycle-safe structured cause classification, closed log-safe cause classes, and cross-bundle unavailable brand.
- `packages/ai/src/utils/retry.ts`: retry a terminal OAuth-unavailable diagnostic before wording classification.

- `retry.ts` now defines `OAUTH_REFRESH_UNAVAILABLE_DIAGNOSTIC` itself, beside the classifier that reads it, so the `./utils/retry` and `./utils/provider-failure-description` entry graphs stay within budget. `oauth-refresh-error.ts` no longer exports it, and its cause walk is bounded at 16 links as well as cycle-safe.
### Why

Opaque transport prose cannot reliably identify transient refresh failures.

### Why an extension could not handle it

Shared retry decisions and cross-package error contracts are core request mechanics.

### Expected merge conflict zones

- `isRetryableAssistantError` and the new shared error module.
