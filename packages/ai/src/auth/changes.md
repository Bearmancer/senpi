## 2026-10-09 - Restore auth-tracker coverage for upstream-modified paths (senpi#3006)

### What changed

- `packages/ai/src/auth/credential-store.ts`: pooled credential entry storage and documentation.
- `packages/ai/src/auth/helpers.ts`: shared auth helpers carried through the v0.99.1 sync and Copilot token re-exchange (senpi#2297).
- `packages/ai/src/auth/types.ts`: auth resolution types — ambient shared-cloud credential chains (senpi#2327), immutable account ids (senpi#1495), and the `ApiKeyAuth.ambientOnly` compatibility marker.

These files were covered by `packages/ai/src/changes.md` until senpi#2895 added this nearer tracker without listing them, hiding them from the audit's exact-nearest-tracker rule.

### Why

The repository audit (`scripts/audit-changes-md.mjs`) requires every upstream-modified production path to be named by an entry in its exact nearest changes.md tracker. senpi#2895 introduced this tracker and named only `oauth-refresh.ts` and `resolve.ts`, so the 3 pre-existing upstream-modified files beneath it lost the coverage the parent tracker had provided and were reported uncovered.

### Why an extension could not handle it

changes.md coverage is fork-owned documentation metadata; no extension or runtime hook can supply it.

### Expected merge conflict zones

- LOW: the `### What changed` bullet list in this entry as future entries are prepended above it.

## 2026-10-07 - Preserve transient OAuth exchange failures (senpi#2893)

### What changed

- `packages/ai/src/auth/oauth-refresh.ts`: preserve caller cancellation; log one JSON-encoded provider/optional-slot/closed-cause line per transient exchange without changing stored credentials. JSON encoding prevents object inspection or embedded newlines from splitting the log record.
- `packages/ai/src/auth/resolve.ts`: map transient exchanges to a symbol-branded OAuth ModelsError while preserving permanent errors and message text.

### Why

Transport failures during refresh lost their retryability and ended unattended turns.

### Why an extension could not handle it

Exchange classification and credential resolution happen before provider requests or extension recovery hooks.

### Expected merge conflict zones

- The exchange catch in `oauth-refresh.ts` and error mapping in `resolve.ts`.
