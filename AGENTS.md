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
`claude -p` / `opencode run` / `codex exec` process that Bean spawns, streams, and cancels via core's `delegate.ts` +
app's `delegate-tasks.ts`, with the result fed back into the chat when it finishes.

The desktop app is one of **three surfaces**, all sharing the same core brain:

- **Remote chatops** — `@bean/discord` and `@bean/teams` are standalone Node bot servers
  (`node dist/server.js`) that let you drive Bean from a Discord server/DM or a Teams chat.
  They render the same confirm-first cards (run / note / skill; memory saves directly with a Forget receipt) through core's shared
  `chatops/` layer; the per-surface `*-config.ts` holds tokens/IDs.
- **Routines** — scheduled work. A routine (`~/.bean/routines/<name>.json`) is a cron- or
  watch-fired (polled feed/command, no model per check) pipeline of `delegate`/`chat`/`command` steps with optional todo-queue draining; `routine-runner.ts`
  runs it and fans results to sinks (chatops channel / note / desktop notification).
- **System control** — `system-control.ts` lets `converse()` drive the Mac (volume, mute,
  media playback, launch/quit apps) via a closed verb union, opt-in behind a Settings toggle.

It's a **pnpm-workspace monorepo** with four packages:

| Package | Path | Purpose |
|---------|------|---------|
| **`@bean/core`** | `packages/core/` | Routing + IO logic. Pure ESM, zero Electron, `tsc`-built. |
| **`@bean/app`** | `packages/app/` | Electron shell (main + preload + renderer). esbuild-bundled. |
| **`@bean/discord`** | `packages/discord/` | Discord bot server. Node, tsc+esbuild-built. |
| **`@bean/teams`** | `packages/teams/` | Teams bot server. Node, tsc+esbuild-built. |

Per-user runtime data lives in `~/.bean/` (not in the repo) — see [Runtime config](#runtime-config-bean).

---

## Environment & Commands

Requires **Node ≥24** and **pnpm 11**. Terminal/delegate runs also need at least one supported
CLI (`opencode`, `claude`, or `codex`) on `PATH`.

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
pnpm --filter @bean/core exec vitest run __test__/converse.test.ts
pnpm --filter @bean/core exec vitest run -t "<test name>"
```

**Validation gate:** run `pnpm test && pnpm typecheck` and confirm both exit 0 before
claiming work is done. If the diff touches `packages/app/` (renderer, CSS, main, preload, or
`e2e/` itself), also run `pnpm build && pnpm --filter @bean/app run test:e2e` and confirm it
exits 0 — the e2e specs assert things unit tests can't see (rendered contrast, window sizes,
chat restore). Core/Discord/Teams-only diffs skip it. When you deliberately change something a
test asserts (a token, a size, a list), grep `packages/app/e2e/` too, not just `__test__/`.
If a change touches subprocesses, spawned CLIs/bots, PATH/env handling,
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
blocks a merge — but a red `e2e` on a PR that touches `packages/app/` is a real failure until
shown to be a flake (re-run it); don't merge over it.

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

Only the boundaries and rules that aren't obvious from the code — use CodeGraph for structure,
call paths and signatures.

- **`@bean/core`** — all routing/IO logic, zero Electron, pure and dependency-injected (rule and
  rationale: [`.memory/convention-core-is-electron-free.md`](.memory/convention-core-is-electron-free.md)).
  Import from `@bean/core` (`index.ts` re-exports everything), not deep paths.
  - `openai-chat.ts` is the only place the `openai` SDK is touched; everything else takes a
    `deps.chat` function, so tests inject a fake (`makeOpenAIChatWithClient`).
  - Three ways to run a CLI: `launcher.ts` is fire-and-forget into Terminal.app (Bean never sees
    the output); `delegate.ts` is a tracked one-shot (stream, collect, cancel the process group);
    `live-session.ts` / `turn-live-session.ts` are multi-turn live sessions (agent mode in the
    desktop chat, live channels in chatops).
  - `system-control.ts` — the model never writes AppleScript; it picks a verb from a closed union
    and each maps to a fixed, validated `execFile` argv. Keep it that way.
  - `chatops/` — only an explicit @mention, reply, or DM gets a turn; untagged channel chatter is
    kept as context (`ambient.ts`). Confirm-first cards are backed by one-shot claim stores.
  - Loaders (`config.ts`, `skill-library.ts`, `project-registry.ts`) take explicit paths;
    missing/invalid files degrade to `[]` — only a missing **config** throws.

- **`@bean/app`** — Electron shell bundled with **esbuild** (not tsc). `main.ts` wires core into
  Electron; `ipc.ts` keeps handlers thin and separable from Electron so they're unit-testable.
  The renderer is Preact: the avatar/orb plus one component window per folder under
  `renderer/components/`.

- **`@bean/discord` / `@bean/teams`** — thin surfaces wiring a platform SDK to core's `chatops/`
  layer. Adding a surface shouldn't touch core logic.

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

- **Files:** kebab-case `.ts` (`skill-library.ts`); Preact components are PascalCase `.tsx`
  (`ChatPanel.tsx`).
- **Modules:** every package is ESM (`"type": "module"`) with `verbatimModuleSyntax` on — use
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

- `~/.bean/config.json` → `BeanConfig` (`core/src/types.ts`; defaults in `loadConfig()`). Only
  `openaiApiKey`/`model` are load-bearing. A missing config throws; an empty `openaiApiKey`
  shows an error dialog but the app still opens.
- `~/.bean/clis.json` → optional per-provider model lists overriding the repo default
  `.bean/clis.json`: `[{ "provider": "claude", "models": ["sonnet", ...] }]`. A user entry
  replaces that provider's default list; model strings are passed verbatim to `--model`.
  Providers are still code (`opencode`, `claude`, `codex`) — only their model lists are config.
- `~/.bean/skills/*.md` → one markdown file per skill. `description:` frontmatter is the
  catalog summary the model sees; otherwise the first heading is used. The full body composes the prompt.
- `~/.bean/projects.json` → `[{ "name": "...", "path": "/abs/path", "defaultSkill": "..." }]`
  (`defaultSkill` optional).
- `~/.bean/routines/*.json` → one routine per file; runtime state (last run, history) lives
  beside them in `.state.json` so definitions stay clean and shareable.
- `~/.bean/bean.db` → SQLite (FTS5) store for memories, notes, chatops history, and the
  `delegate_runs` session log ([`.memory/project-delegate-session-receipts.md`](.memory/project-delegate-session-receipts.md)). Other files: `persona.json`, `reminders.json`.

All path helpers live in `core/src/config.ts` — check there for the current set, don't
hand-maintain the list here.

---

## Review policy (AI reviewers on PRs)

Automated reviewers (Codex, CodeQL, any LLM reviewer) never run out of findings — they
re-review the whole PR on every push and sample a different subset of the effectively
unbounded P2 pool each round. **Reviewer silence is not the merge criterion and never
arrives**; this policy is. It applies to humans and agents fixing review feedback alike.

**Triage every finding, don't reflex-fix it:**

- **P0/P1 on lines this PR touched** — fix in-PR, always.
- **P2 on lines this PR touched** — fix in-PR only if the fix is small and local (a few
  lines, no new dependency, no new endpoint/config/surface). Otherwise reply "deferred per
  review policy", file a follow-up issue or `.memory` note, and resolve the thread.
- **Any finding outside the PR's diff** — backlog (issue), never blocks the merge.
- **Prefer deleting surface over armoring it.** If a finding's "proper" fix adds an
  endpoint, dependency, token scheme, or config knob, first ask whether the feature slice
  that needs it is worth keeping at all — a plain-text fallback or explicit user notice
  often beats an armored subsystem. (Case study: PR #94's Teams image hosting — one size
  limit finding escalated into route + capability tokens + rate limiting + config across
  three review rounds, then the whole stack was deleted in favor of posting the file path.)

**Stop criterion:** at most **2 review rounds** after the PR is opened. After that, merge
when CI is green and no P0/P1 is open; everything else becomes issues. Batch a round's
fixes into **one push** — every push re-triggers a full re-review.

**Deposit an artifact per accepted finding class:** a fixed finding should leave behind the
thing that kills its whole class — a `.memory/` entry, a test, or a checklist line (see
[`.memory/convention-new-external-surface.md`](.memory/convention-new-external-surface.md))
— so the next PR doesn't re-litigate it.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
