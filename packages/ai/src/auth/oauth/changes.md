## 2026-10-09 - Restore oauth-tracker coverage for upstream-modified paths (senpi#3006)

### What changed

- `packages/ai/src/auth/oauth/load.ts`: the bundled OAuth flow loader registry — the `cursor` flow joined the lazy loader registry and the standalone-Bun static bundle, and the subscription-provider symbol/module renames (senpi#1989) and the Devin CLI login flow were carried through the v0.99.1 sync.
- `packages/ai/src/auth/oauth/openai-codex.ts`: the retired/renamed Codex OAuth flow kept as a compatibility module after the chatgpt-subscription rename (senpi#1989) and the v0.99.1 retired-path sync.

These files were covered by `packages/ai/src/changes.md` until senpi#2895 added this nearer tracker without listing them, hiding them from the audit's exact-nearest-tracker rule.

### Why

The repository audit (`scripts/audit-changes-md.mjs`) requires every upstream-modified production path to be named by an entry in its exact nearest changes.md tracker. senpi#2895 introduced this tracker and named only the per-provider token-error modules it touched, so these 2 pre-existing upstream-modified files lost the coverage the parent tracker had provided and were reported uncovered.

### Why an extension could not handle it

changes.md coverage is fork-owned documentation metadata; no extension or runtime hook can supply it.

### Expected merge conflict zones

- LOW: the `### What changed` bullet list in this entry as future entries are prepended above it.

## 2026-10-07 - Token endpoint errors retain HTTP status (senpi#2893)

### What changed

- `packages/ai/src/auth/oauth/anthropic.ts`: typed HTTP failures and original transport cause on refresh wrappers.
- `packages/ai/src/auth/oauth/chatgpt-subscription.ts`: typed token response errors and preserved fetch cause.
- `packages/ai/src/auth/oauth/cursor.ts`: typed refresh HTTP errors.
- `packages/ai/src/auth/oauth/github-copilot.ts`: typed token endpoint HTTP errors.
- `packages/ai/src/auth/oauth/kimi-coding.ts`: typed refresh HTTP errors, including the existing retry loop's last error.
- `packages/ai/src/auth/oauth/openai-chatgpt.ts`: typed direct token response errors.
- `packages/ai/src/auth/oauth/xai.ts`: typed OAuth request errors.
- `packages/ai/src/auth/oauth/openrouter.ts`: typed key exchange errors; permanent-key refresh remains a no-op.
- `packages/ai/src/auth/oauth/radius.ts`: its existing status-bearing response error extends the shared endpoint error.
- `packages/ai/src/auth/oauth/devin-token.ts`: typed token exchange errors; Devin's no-op refresh remains unchanged.

- `cursor.ts`, `xai.ts`, `radius.ts`, `kimi-coding.ts`: the cancelled/aborted errors they throw when the refresh signal aborts keep `signal.reason` as `cause`. When the shared refresh's 15 s cap fires, that reason is the `TimeoutError`, so the failure classifies transient as it does for the other providers; the message text is unchanged.

- `xai.ts`: an error page that is not JSON (an HTML 503 from a proxy, say) is thrown as `OAuthTokenEndpointError` with its status, so it classifies transient; a 2xx with an unreadable body stays a plain error.
### Why

HTTP status and transport causes must survive provider wrappers so token refresh can distinguish outages from expired grants without matching prose.

### Why an extension could not handle it

The provider's private token exchange constructs these errors before an extension sees them.

### Expected merge conflict zones

- HTTP failure constructors and catch wrappers in the listed provider modules. Existing message text is preserved.
