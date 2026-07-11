# AGENTS.md — AI & Developer Handbook

> **Canonical guide** for every AI tool (Claude Code, Codex, Cursor, OpenCode, …) and human
> working on this repo. Tool-specific files (`CLAUDE.md`) point here; don't duplicate rules there.
>
> **Authority order — when sources disagree, trust higher first:**
> 1. **`AGENTS.md`** (this file) — rules, workflows, decisions.
> 2. **`.memory/`** — durable, committed learnings (see [Memory protocol](#memory-protocol)).
> 3. **Source code + CodeGraph** — authoritative for behavior, structure, signatures.
> 4. **`README.md` / `docs/`** — reference snapshots; **may lag the code, verify before relying.**
>
> Tiers 1–2 win on *rules and decisions*; tier 3 wins on *what the code actually does*. When a
> `.memory/` entry (or this file) contradicts the code's behavior, trust the code and fix the
> entry in the same change. Don't hand-maintain in docs what CodeGraph/source already provides
> (file trees, call graphs, signatures) — it only drifts.

---

## Session start checklist

Before touching code:

1. Read this file.
2. Read [`.memory/INDEX.md`](.memory/INDEX.md) and follow links relevant to your task. Treat `safety-*` entries as load-bearing.
3. **Never work directly on `main`.** For every new task, create an isolated worktree first:
   `pnpm worktree:create <branch-name>` — this checks out `.worktrees/<branch-name>` off a new
   branch and runs `codegraph init` inside it, then work from that directory. When the task is
   done, remove it with `pnpm worktree:remove <branch-name>` (see
   [Worktrees](#worktrees) below).

---

## Project Overview

Bean is a desktop-pet Electron app. Double-click the avatar (or drop a URL on it) → chat in
the ChatWindow → `converse()` builds a system prompt from persona/skills/projects/memories and
may propose a run (skill + project + instruction) → user reviews/confirms in a ProposalCard →
Bean writes a temp shell script and opens it in Terminal.app (or launches `zed` directly for
open mode). Bean does not stream or track the launched process's output. The exception is
**delegation**: `converse()` can also propose a delegate run (`propose_delegate`) — a headless
`claude -p` / `opencode run` that Bean spawns, streams, and cancels via core's `delegate.ts` +
app's `delegate-tasks.ts`, with the result fed back into the chat when it finishes.

It's a **pnpm-workspace monorepo** with two packages:

| Package | Path | Purpose |
|---------|------|---------|
| **`@bean/core`** | `packages/core/` | Routing + IO logic. Pure ESM, zero Electron, `tsc`-built. |
| **`@bean/app`** | `packages/app/` | Electron shell (main + preload + renderer). esbuild-bundled. |

Per-user runtime data lives in `~/.bean/` (not in the repo) — see [Runtime config](#runtime-config-bean).

---

## Environment & Commands

Requires **Node ≥24**, **pnpm 11**, and **`opencode` on `PATH`**.

Root scripts run through Turborepo (which builds `^build` deps first):

```bash
pnpm install
pnpm build       # turbo: tsc @bean/core, then esbuild-bundle @bean/app
pnpm test        # turbo: vitest run in every package
pnpm typecheck   # turbo: tsc --noEmit in every package
pnpm dev         # build core + app, then `electron dist/main.js`
```

Per-package / single test:

```bash
pnpm --filter @bean/core test
pnpm --filter @bean/core exec vitest run __test__/router.test.ts
pnpm --filter @bean/core exec vitest run -t "falls back"   # by test name
```

**Validation gate:** run `pnpm test && pnpm typecheck` and confirm both exit 0 before
claiming work is done. If a change touches subprocesses, spawned CLIs/bots, PATH/env handling,
Electron resources, app boot, IPC/preload, window/tray behavior, or anything that differs between
source checkout and packaged app, also verify both worlds before claiming done:

- **Dev:** run the relevant `pnpm dev`/package build path or a direct child-process smoke test
  from the repo checkout.
- **Compiled:** run `pnpm dist:mac`, inspect/use the built `Bean.app` under
  `packages/app/release/mac-*/Bean.app`, and smoke-test the exact packaged entry/resource path.

Do not trust unit tests, `pnpm build`, or dev-mode success for packaged behavior. Clear stale
state between those checks (quit old Bean instances, stop child processes, rebuild the package,
and use fresh temp `HOME`/`~/.bean` fixtures when config affects the result). CI
(`.github/workflows/ci.yml`) runs the same two commands on every push to `main` and every PR,
plus an `e2e` job (Playwright driving the real built Electron app — see `packages/app/e2e/`) on
`macos-latest`. The `e2e` job is advisory, not a required check, so an occasional flake never
blocks a merge — but check its result before merging a PR that touches app boot, IPC, or window
behavior.

---

## Worktrees

Never edit code on `main`. Every new task gets its own git worktree, wired through root pnpm
scripts (`scripts/worktree.sh`):

```bash
pnpm worktree:create <branch-name>   # .worktrees/<branch-name>, new branch, then `codegraph init`
pnpm worktree:remove <branch-name>   # git worktree remove + delete the branch
```

Worktrees live under `.worktrees/` at the project root (gitignored). `codegraph init` is run
automatically inside the new worktree because the `.codegraph/` index isn't shared across
worktrees — each checkout needs its own.

---

## Architecture

- **`@bean/core`** — all routing/IO logic, zero Electron, pure and dependency-injected (the
  rule and rationale: [`.memory/convention-core-is-electron-free.md`](.memory/convention-core-is-electron-free.md)):
  - `converse.ts` `converse()` builds a system prompt from persona, skills/projects catalog,
    and memories, and can call the `propose_run` tool (skill + project + instruction) to
    return a `ConverseResult` with an optional `proposedRun: RouteSuggestion`. This is the
    active path behind the ChatWindow.
  - `router.ts` `route()` takes a `deps.chat` function, not an OpenAI client. It always
    returns a `RouteSuggestion`; on any chat/parse failure or an unknown skill/project it
    **falls back** to `projects[0]` + its `defaultSkill` (or `skills[0]`) with `confidence: 0`.
    Never throws. Still wired up (`window.bean.route()` → `bean:route` → `buildRouteHandler()`)
    but no renderer code calls it anymore — `converse()` supersedes it for the chat flow.
  - `launcher.ts` `launchCommand()`/`launchInTerminal()` handle the launch modes `"opencode"`,
    `"claude"`, and `"open"` (zed). For `"opencode"`/`"claude"` it writes a temp
    `bean-run-*.command` script and opens it via `open -a <terminalApp>`; for `"open"` it
    spawns `zed` directly. Fire-and-forget — Bean does not stream or track that process's output.
  - `delegate.ts` `runDelegate()` is the tracked counterpart to the launcher: it spawns a
    headless CLI (`delegateCommand()` maps claude/opencode flags), streams a parsed tail,
    collects the final result, and can cancel the process group. Pure and DI'd like the rest.
  - `openai-chat.ts` is the only place the real `openai` SDK is touched; it adapts the client
    to the `deps.chat` shape. `makeOpenAIChatWithClient` exists so tests inject a fake client.
  - `config.ts` / `skill-library.ts` / `project-registry.ts` are pure loaders taking explicit
    paths. Missing/invalid files degrade to `[]`; only a missing **config** throws.
  - `index.ts` re-exports everything; import from `@bean/core`, not deep paths.

- **`@bean/app`** — Electron shell bundled with **esbuild** (not tsc). `main.ts` is the wiring
  layer: loads `~/.bean` config via core, builds the real OpenAI chat fn, opens windows, calls
  `registerIpc`. `ipc.ts` keeps handlers thin and testable (`buildChatHandler`/`buildLaunchHandler`
  are separable from Electron). The renderer is `avatar.ts`/`orb.ts` plus component windows
  under `renderer/components/` (`chat`, `plan`, `projects`, `skills`, `persona`, `settings`,
  `about`) — there is no `intake`/`console` page anymore.

Control flow: `ChatWindow` → `window.bean.chat()` (preload bridge) → IPC `bean:chat` →
`buildChatHandler()` → `converse()` → optional `proposedRun` rendered as a `ProposalCard` →
user confirms → `window.bean.launch()` → IPC `bean:launch` → `buildLaunchHandler()` →
`launchInTerminal()` → Terminal.app / CLI.

Subsystem gotchas that have bitten before live in `.memory/` — read the relevant entry
**before** touching that area (preload bundling, IPC channels, window behavior). `INDEX.md`
is the catalog.

---

## Memory protocol

Two layers:

1. **Team memory** — [`.memory/`](.memory/), checked into the repo, cross-tool. Read
   [`.memory/INDEX.md`](.memory/INDEX.md) at session start. When you learn something the next
   agent should know (a quirk, a "don't undo this", a durable fact), add a kebab-case entry
   prefixed by category (`safety-`, `convention-`, `project-`), link it from `INDEX.md`, and
   commit it **in the same change** as the work. Keep entries short. If an entry contradicts the
   code, **trust the code and fix the entry** in the same change.
2. **Personal memory** — your tool's own per-user store (e.g. Claude Code's
   `~/.claude/projects/.../memory/`, Codex's `~/.codex/`). Use it for personal preferences and
   workflow style. **Never commit personal memory into `.memory/`.**

---

## Code Style

- **Files:** kebab-case (`skill-library.ts`, `openai-chat.ts`); TypeScript `.ts`.
- **Modules:** both packages are ESM (`"type": "module"`) with `verbatimModuleSyntax` on — use
  `.js` extensions in relative imports (`from "./types.js"`) and `import type` for type-only
  imports. The **one exception** is the Electron preload, which is emitted as CommonJS `.cjs`.
- **Async:** async/await with explicit `Promise<T>` return types on exports.
- **Design:** new IO belongs in `@bean/core` as a pure, dependency-injected function; new
  Electron wiring belongs in `app/` — see [`.memory/convention-core-is-electron-free.md`](.memory/convention-core-is-electron-free.md).
- **Types:** `strict` + `noUncheckedIndexedAccess` are on, so array access is `T | undefined` —
  handle it. Renderer↔main types flow through `@bean/core` types plus the `window.bean` shape
  in `app/src/renderer/bean.d.ts`.
- **Linting:** no ESLint/Prettier config — follow these conventions manually. `tsc --noEmit`
  (`pnpm typecheck`) under `strict` is the type gate.

---

## Runtime config (`~/.bean`)

Per-user, outside the repo. Path helpers live in `core/src/config.ts`.

- `~/.bean/config.json` → `{ "openaiApiKey": "sk-...", "model": "gpt-4o-mini" }` (`model`
  optional, defaults to `gpt-4o-mini`). A missing config throws; an empty `openaiApiKey`
  shows an error dialog but the app still opens.
- `~/.bean/skills/*.md` → one markdown file per skill. `description:` frontmatter is the
  router-visible summary; otherwise the first heading is used. The full body composes the prompt.
- `~/.bean/projects.json` → `[{ "name": "...", "path": "/abs/path", "defaultSkill": "..." }]`
  (`defaultSkill` optional; the first project + its default skill is the router fallback).

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
