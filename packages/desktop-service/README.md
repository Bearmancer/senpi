# @code-yeongyu/senpi-desktop-service

Runs one `senpi-desktop-engine` child process per agent session and talks JSON-RPC to it over stdio. It also hosts the `computer.run` runtime. This package is a skeleton until todos 19-20 of the computer-use plan fill it in.

## Engine spawn contract

- `@code-yeongyu/senpi-desktop-engine` locates the binary. In development that is `target/release/senpi-desktop-engine` or the vendored `native/prebuilds/<host>/senpi-desktop-engine[.exe]`. In a compiled senpi binary it is the sidecar copy at `<execDir>/native/prebuilds/<host>/senpi-desktop-engine[.exe]`.
- The service spawns that binary with the single argument `--stdio` and piped stdin, stdout, and stderr.
- The child inherits `SENPI_DESKTOP_BACKEND` (tests use it to select the fake backend). On Linux it also inherits `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, and `XDG_RUNTIME_DIR`.
- The engine is an asset, not a bundled entry. It adds no senpi compile entry and no argv discriminator, and it does not change `session-worker-compile`.

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
