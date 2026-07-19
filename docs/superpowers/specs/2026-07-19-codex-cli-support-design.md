# Codex CLI Support — Design

**Date:** 2026-07-19
**Status:** Approved for planning

## Goal

Add OpenAI's `codex` CLI as Bean's third supported CLI, alongside `claude` and `opencode`, with
the same surface parity as opencode: interactive Terminal.app launches and headless delegate runs
(chat proposals, routines, chatops delegate cards). Live-session stays claude-only (see
Follow-ups).

## Approach

Extend the existing unions and switch branches — no provider-registry abstraction. Three
providers and two call sites don't justify a descriptor table; revisit at CLI #5. Everything
downstream (Settings dropdown, ProposalCard/DelegateCard CLI+model pickers, chatops model
resolution) derives from `detectClis()` + `CliModels`, so it needs no changes.

## Changes

### 1. Types + detection — `packages/core/src/launcher.ts`

- `LaunchMode = "opencode" | "claude" | "codex" | "open"`
- `CliName = "opencode" | "claude" | "codex"`
- `detectClis()` candidate list gains `"codex"`.

### 2. Interactive launch — `launchCommand()`

```ts
case "codex":
  return { command: "codex", args: [...(req.model ? ["--model", req.model] : []), req.prompt ?? ""] };
```

Codex's TUI takes a positional prompt; the generated `.command` script already `cd`s into
`projectPath`. Mirrors the claude case.

### 3. Headless delegate — `packages/core/src/delegate.ts`

New branch in `delegateCommand()`:

```
codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check [--model <m>] <prompt>
```

- **Full bypass** (not `--full-auto`): matches the claude delegate path's
  `--dangerously-skip-permissions`. Headless runs can't answer approval prompts, and the
  workspace-write sandbox blocks network (git push, gh) which routines need.
- **`--skip-git-repo-check`**: codex exec refuses to run outside a git repo; Bean's scratch
  workspace (no project picked) isn't one.
- New `codexTailLine()` / `codexResult()` (~20 lines) parsing codex's `--json` JSONL events —
  `item.completed` items for tail lines, the final `agent_message` item for the result — same
  pattern as `claudeTailLine`/`claudeResult`. `handleLine` in `runDelegate` dispatches per cli.
  Unparseable lines already fall through as raw output, so a codex event-shape drift degrades to
  opencode-style raw streaming, not breakage. **Exact event shapes must be verified against the
  installed codex version during implementation** (fixtures from a real `codex exec --json` run).

### 4. Models config

- `KNOWN_PROVIDERS` in `packages/core/src/cli-models.ts` gains `"codex"`.
- Repo default `.bean/clis.json` gains a codex entry. Default model list confirmed against the
  installed codex at implementation time; users override via `~/.bean/clis.json` regardless.

### 5. App wiring

- `packages/app/src/main.ts` preferred-delegateCli check (`main.ts:452`) accepts `"codex"`.
- `packages/app/src/renderer/components/projects/ProjectsPanel.tsx` gains a
  `{ mode: "codex", label: "codex", needsPrompt: true }` launch button.
- `packages/core/src/types.ts` `delegateCli` comment mentions codex.
- Settings dropdown, ProposalCard, DelegateCard, RoutinesPanel, chatops resolve: **no changes**
  — all derived from `detectClis()`/`CliModels`.

### 6. Out of scope

- Live-session stays claude-only: it depends on claude's `--input-format stream-json` stdin
  turn-injection, which codex lacks. Chatops' claude-only live-session filters
  (`bot.ts:233-235`, discord `server.ts:69/107/331`) stay as-is.

## Error handling

Existing paths cover codex: ENOENT on launch surfaces via `fireAndForget`'s error handler;
delegate nonzero exit surfaces stderr tail; JSON parse failures degrade to raw lines. No new
error machinery.

## Testing

- `launcher.test.ts`: codex `launchCommand` argv.
- `delegate.test.ts`: codex `delegateCommand` argv; `codexTailLine`/`codexResult` against real
  captured JSONL fixtures; `runDelegate` end-to-end with a fake spawn emitting codex events.
- `cli-models.test.ts`: codex provider accepted by `parseCliModels`.
- Gate: `pnpm test && pnpm typecheck`, plus dev **and** packaged (`pnpm dist:mac`) smoke tests
  per AGENTS.md — this touches spawned CLIs and PATH handling.

## Follow-ups (not in this change)

**Codex live-session via `codex exec resume`.** Codex has no stdin turn-injection, but persists
session state under `~/.codex/sessions/`. A codex live-session could spawn
`codex exec --json <prompt>` for the first turn, capture the thread id from the `thread.started`
event, then spawn `codex exec resume <id> --json <text>` per subsequent `send()` —
process-per-turn instead of one long-lived process. Bean would queue a `send()` arriving
mid-turn until the running turn's process exits. Alternative if mid-turn steering or approval
flows are ever needed: `codex app-server` (bidirectional JSON-RPC 2.0 over stdio, the protocol
behind codex's IDE surfaces) — much more code. Researched 2026-07-19; see
[non-interactive mode docs](https://developers.openai.com/codex/noninteractive) and the
[app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).
