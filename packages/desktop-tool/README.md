# @code-yeongyu/senpi-desktop-tool

Defines the senpi `computer` tool: its permission tiers, settings, the `/computer` command, the supported-host policy, and activation hooks. This package is a skeleton until todo 24 of the computer-use plan fills it in.

## Settings

None yet.

## Import direction

`scripts/desktop-package-boundaries.test.mjs` enforces these edges, in both `package.json` and `src/`:

- `@code-yeongyu/senpi-desktop-protocol` and `@code-yeongyu/senpi-desktop-prelude` import no workspace package.
- `@code-yeongyu/senpi-desktop-engine` may import `-protocol`.
- `@code-yeongyu/senpi-desktop-service` may import `-protocol`, `-engine`, and `-prelude`.
- `@code-yeongyu/senpi-desktop-tool` may import `-protocol`, `-engine`, `-prelude`, and `-service`.
- `@code-yeongyu/senpi` (coding-agent) may import only `-tool` and `-service`. `@code-yeongyu/senpi-codemode` imports none of them.
- No desktop package imports `pi-agent-core`, `pi-ai`, or `pi-tui`. There is no shared utils package: the five desktop packages are the whole set.

The Rust side runs the other way: `senpi-desktop-core` <- `-safety` <- `-session` <- backends <- `senpi-desktop-engine` (the binary). The TS packages reach it only through the engine's stdio JSON-RPC.
