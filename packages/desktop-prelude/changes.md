# senpi-desktop-prelude fork changes

## 2026-09-24 - Desktop package wired into the workspace (senpi#2128)

### What changed

- `packages/desktop-prelude/`: skeleton package (empty entry plus one placeholder test) wired into the workspace, the build phases, the entry-graph budgets, and the bundled-workspace staging. Todo 23 fills it.

### Why

- Desktop computer use (senpi#2128) ships as five flat TS packages. Every enumerating script has to know about all five before any of them gains behavior, or publish staging breaks.

### Why an extension could not handle it

- This package is fork-only. The wiring lives in root build and publish scripts that run before any extension loads.

### Expected merge conflict zones

- None in this package: it does not exist upstream.
