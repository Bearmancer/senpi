## 2026-09-29 - Published tarball excludes sourcemaps (senpi#2362)

### What changed

- `packages/telemetry/package.json`: `files` excludes `dist/**/*.map`.

### Why

- The maps point at `src/`, which is not published, so they cannot resolve for consumers and only add install size.

### Why an extension could not handle it

- Package publish metadata.

### Expected merge conflict zones

- LOW: the `files` list in `package.json`.

# changes

## 2026-09-21 - Migrate the test runner to Vitest 5 (senpi#1895)

### What changed

- `packages/telemetry/package.json`: Updated the test runner to Vitest 5.0.1.

### Why

- Run this workspace on the pinned Vitest 5 release.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.

### Expected merge conflict zones

- The development dependency pins in `packages/telemetry/package.json`.
