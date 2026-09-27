# @code-yeongyu/senpi-desktop-protocol

Defines the engine JSON-RPC types, the session snapshot, the error codes, and the computer-call approval tiers. `src/engine-schema.generated.ts` is generated from the engine method table with `bun run generate`. Never edit it by hand.

## Settings

None.

## Import direction

`scripts/desktop-package-boundaries.test.mjs` enforces these edges, in both `package.json` and `src/`:

- `@code-yeongyu/senpi-desktop-protocol` and `@code-yeongyu/senpi-desktop-prelude` import no workspace package.
- `@code-yeongyu/senpi-desktop-engine` may import `-protocol`.
- `@code-yeongyu/senpi-desktop-service` may import `-protocol`, `-engine`, and `-prelude`.
- `@code-yeongyu/senpi-desktop-tool` may import `-protocol`, `-engine`, `-prelude`, and `-service`.
- `@code-yeongyu/senpi` (coding-agent) may import only `-tool` and `-service`. `@code-yeongyu/senpi-codemode` imports none of them.
- No desktop package imports `pi-agent-core`, `pi-ai`, or `pi-tui`. There is no shared utils package: the five desktop packages are the whole set.

The Rust side runs the other way: `senpi-desktop-core` <- `-safety` <- `-session` <- backends <- `senpi-desktop-engine` (the binary). The TS packages reach it only through the engine's stdio JSON-RPC.
