# Permission System Builtin Extension

## 2026-10-01 - Read shipped resources without approval (#2513)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/parsers.ts`: the read parser delegates to `read-permission.ts`, which uses the read tool's path resolver and canonical containment for shipped resources and outside paths.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts`: passes the read parser's internal prompt-suppression marker to the permission service; internal-tool allow-list policy is unchanged.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/service.ts`: evaluates every read rule, including explicit denies, before suppressing ask results for shipped resources. Permission request and approval-storage shapes are unchanged.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/evaluate.ts`: bundled read aliases (raw, normalized and canonical) are matched as one target with the existing last-rule precedence, preserving relative-path and resolved-symlink denies as well as later explicit allows.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/external-dir.ts`: shares the existing parent-directory approval pattern logic with the read parser and keeps filesystem-root targets scoped to their individual file on every platform.

### Why

- Bundled skill reads were classified as external directories, and ask-first also requested read approval. Symlinks escaping the shipped payload and writes must retain their normal permission policy.

### Why an extension could not handle it

- The permission builtin owns classification before the actual read tool executes.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/permission-system/parsers.ts`: imports and the read parser only; no internal-tool allow-list changes.

## 2026-09-27 - Tools classify their own calls with `permissionParser`

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/parsers.ts`: `ParserRegistry.has()`, and `toolOwnedPermissionRequests()`, which reads a tool's `permissionParser` from `pi.getAllTools()`.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts`: `tool_call` uses the built-in parser when one exists, else the tool's own parser, else the single request named after the tool.

### Why

- An extension tool can expose read and exec tiers (for example `my_tool:exec=deny`), resolved per session from the session's own tools. A tool can never replace a built-in parser.

### Why an extension could not handle it

- The permission-system builtin owns parsing.

### Expected merge conflict zones

- LOW: the parse call at the top of the `tool_call` handler.

## Overview
Full port of opencode's permission system to senpi-mono as a builtin extension.

## Files
- `types.ts` - Core type definitions (Action, Rule, Request, Reply, etc.)
- `evaluate.ts` - Rule evaluation engine with wildcard matching
- `arity.ts` - Bash command arity parser
- `config.ts` - Config transforms (fromConfig, merge, disabled)
- `storage.ts` - JSONL persistence layer
- `external-dir.ts` - External directory detection
- `service.ts` - Permission service core (ask/reply/list)
- `events.ts` - Event system (permission_asked/replied)
- `parsers.ts` - Tool input parser registry
- `prompt.ts` - TUI permission prompt
- `non-interactive.ts` - No-UI fallback handler
- `settings.ts` - settings.json integration
- `cli.ts` - CLI flag parsing
- `index.ts` - Extension entry point

## Why Builtin Extension?
Following pi-mono's extension-first philosophy. All permission logic is in the extension, zero core tool modifications.

## 2026-09-07 - monitor path parser derives the approved parent without realpath

### What changed

- `parsers.ts` monitor parser: the approved-parent identity for a `monitor` `path` is now `realpathWithoutOpen(dirname(resolve(cwd, path)))` (shared walker in `src/utils/paths.ts`) instead of `fs.realpathSync(...)`, and the surrounding try/catch is gone because the walker never throws (a missing parent is kept verbatim; registration still performs the authoritative `access` check).
- `external-dir.ts` imports the same shared walker; its private `normalizePath` copy moved to `src/utils/paths.ts` unchanged so every main-thread path resolution uses one implementation.

### Why

- The `tool_call` hook runs on the host main thread, and the 2026-09-06 fix only covered the command tokenizer. `monitor({ path })` still hit `fs.realpathSync` on the parent directory; Bun's realpath `open(2)`s every directory it resolves, so a path under a wedged autofs trigger (`/home/x.log` on a macOS host whose automounter never answers) froze the whole TUI exactly like #1416.
- The registry (`terminal/monitor-registry.ts`) compares this approved parent byte-for-byte with its own resolution, and Bun's realpath canonicalises case (`/users/X` -> `/Users/X`), so both sides had to switch to the same walker in one change; see `terminal/changes.md` (2026-09-07).

### Expected merge conflict zones

- `parsers.ts` monitor parser registration block (`registry.register("monitor", ...)`) and its `node:fs` import.
- `external-dir.ts` import block (the walker body left this file).
- `test/permission/monitor-parser-parent.test.ts` (new: approved parent with realpath denied, relative path, symlinked parent, execute-only parent).

## 2026-09-06 - external-dir path normalization never opens path components

### What changed

- `external-dir.ts` `normalizePath()` resolves symlinks with a component walker built on `fs.lstatSync` + `fs.readlinkSync` (bounded by `MAX_SYMLINK_HOPS`), keeping components from the first missing one onward verbatim. It replaces the `fs.realpathSync` walk-up that climbed a non-existent path to its nearest existing ancestor.

### Why

- `extractExternalPaths()` runs inside the `tool_call` hook on the host main thread for every `bash`/`monitor` command. Bun implements `fs.realpathSync`, `realpathSync.native`, and `fs.promises.realpath` by `open(2)`-ing the path, so a command that merely mentioned `/home/user/work/x` (a path on a remote Linux box) climbed to `realpathSync("/home")`, an autofs trigger on macOS; the wedged automount never returned and the whole TUI froze (senpi #1416). The same open-based resolution fails with EACCES on execute-only directories, so files under them inside the project were reported as external.
- `lstat` needs only search permission and never triggers a mount; this is what realpath(3) itself does.

### Expected merge conflict zones

- `external-dir.ts` `normalizePath` body.
- `test/permission/external-dir-resolution.test.ts` (new file: filesystem-backed `isExternalPath` cases — symlinked cwd, execute-only directory, symlink escape, symlink loop; the symlinked-cwd case moved here from `external-dir.test.ts`).

## 2026-08-21 - Fix unhandled rejection on session shutdown with pending permissions

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts`: attached immediate rejection catch handler to `service.ask(request)` promise during `tool_call` so that when `session_shutdown` rejects pending permission requests (or cascade rejection occurs), no unhandled promise rejection or `uncaughtException` is triggered while the prompt is pending.

### Why

- When a session is cleared (`/clear`), reloaded, or terminated while a tool permission prompt is pending, `session_shutdown` rejects all pending permission requests with `RejectedError`. Previously, `askPromise` was floating without an attached `.catch()` handler until after the UI prompt resolved, causing Node.js to fire an `unhandledRejection` event that crashed interactive mode via `uncaughtException`.

### Why this belongs in the builtin extension

- External extensions cannot observe or attach a rejection handler to `PermissionService`'s private request promise. The permission-system builtin owns that promise and the `tool_call` / `session_shutdown` lifecycle, so it must attach the handler immediately when creating the request.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts` `tool_call` event handler.

## 2026-06-23 - permission presets

### What changed and why
- Added `permissionPreset` settings and `--permission-preset` CLI support with `full-access` as the default.
- Added `workspace`, `read-only`, and `ask` presets that mask lower-precedence wildcard allows before applying their own policy.
- Kept approved JSONL storage unchanged; session approvals still load separately after static rules.

### Files modified
- `types.ts`
- `config.ts`
- `cli.ts`
- `settings.ts`
- `index.ts`

### Expected merge conflict zones
- `settings.ts` merge order if upstream changes settings precedence.
- `config.ts` preset rule definitions if upstream adds default permission policy.
- `index.ts` extension flag registration if upstream moves permission flags into core args.

## 2026-05-11 - Local wildcard matcher

### What changed and why
- Moved the wildcard matcher into `permission-system/wildcard.ts` so permission evaluation owns its matching logic locally.
- Added focused wildcard regression coverage under `test/suite/permission-system-wildcard.test.ts`.

### Files modified
- `evaluate.ts`
- `wildcard.ts`

### Expected merge conflict zones
- `evaluate.ts` imports if upstream also changes rule matching.

## 2026-04-13 - apply_patch path extraction

### What changed and why
- Extended `apply_patch` permission parsing and request metadata extraction to read file paths from patch bodies (`input` / `patchText`) instead of falling back to wildcard edit permissions.
- This change was required once GPT sessions started using `apply_patch` instead of `write` / `edit`; otherwise permission prompts and approvals would lose per-file scope.

### Files modified
- `parsers.ts`
- `index.ts`

### Expected merge conflict zones
- `parsers.ts` edit-tool parsing logic
- `index.ts` request metadata extraction

## bash_input gated as bash-class command execution (2026-07-07)

- `parsers.ts`: the persistent-terminal `bash_input` tool writes arbitrary stdin to a live
  shell = arbitrary command execution, so it is parsed off its `input` field into the SAME
  `bash` permission class (shared `parseBashLikePermission` helper). Otherwise read-only/ask
  presets would be bypassable by steering a background session. `kill_bash`/`bash_resize`/
  `bash_output` fall back to their own tool-named (session-control/read) permissions.
## 2026-09-30 - Edit-only project preset (senpi#2430, DESKTOP-55)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/permission-system/config.ts`: accept-edits starts with a wildcard ask reset, allows read/list/grep/edit, asks bash and external_directory, and exports its host capability name.
- `packages/coding-agent/src/core/extensions/builtin/permission-system/types.ts`, `cli.ts`, `index.ts`, `settings.ts`: accept-edits is accepted in settings/CLI and documented by flag help and validation guidance. Settings tests assert acceptance/rejection behavior rather than the validation sentence.

### Why

workspace allows bash. A client promising automatic project edits and command confirmation needs a separate preset.

### Why an extension could not handle it

The permission-system builtin owns preset policy and parsing; all policy remains in this extension.

### Expected merge conflict zones

Preset union, CLI switch and rules table. Existing workspace semantics and approval storage remain unchanged.
