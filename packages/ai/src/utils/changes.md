## 2026-10-07 - Structured OAuth refresh retry facts (senpi#2893)

### What changed

- `packages/ai/src/utils/oauth-refresh-error.ts`: shared HTTP error, cycle-safe structured cause classification, closed log-safe cause classes, and cross-bundle unavailable brand.
- `packages/ai/src/utils/retry.ts`: retry a terminal OAuth-unavailable diagnostic before wording classification.

### Why

Opaque transport prose cannot reliably identify transient refresh failures.

### Why an extension could not handle it

Shared retry decisions and cross-package error contracts are core request mechanics.

### Expected merge conflict zones

- `isRetryableAssistantError` and the new shared error module.
