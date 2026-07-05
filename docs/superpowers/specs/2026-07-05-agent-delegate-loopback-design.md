# Agent Delegate Loopback — Design

**Date:** 2026-07-05
**Status:** Approved (brainstorming session)

## Problem

Bean can trigger work in a project via `launchInTerminal()`, but that path is deliberately
fire-and-forget: Bean hands a `.command` script to Terminal.app and never learns what
happened. That means Bean's chat model can *route* work but never *use its results* — no
follow-ups, no chaining, no "do X and tell me what you found."

## Goal

Add a **delegate** capability: Bean hands a complex task to an external agent harness in
headless mode (`claude -p` or `opencode run`), tracks the run, and feeds the result back
into the conversation — subagent semantics. The existing Terminal launch stays untouched
as the "drop me into an interactive session" path.

## Decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Run model | Async task: delegation returns immediately; result arrives later via IPC push. Chat stays usable. |
| Trust model | Confirm-first (card like ProposalCard) + full write via an explicit tool allowlist — never `--dangerously-skip-permissions`. |
| Loopback | Agent's final output re-enters `converse()` as a tool-result turn; Bean's model summarizes in its own voice and can chain. |
| Harnesses | Both `claude` and `opencode`, detected via `detectClis()`; the **user** picks a default delegate CLI in Settings. The chat model does not choose the harness. |
| Progress UI | Status card in chat: elapsed time, expandable live output tail, cancel button. |
| Task shape | `project` + `instruction`, with `skill` **optional** — a matching skill composes into the prompt via `composePrompt()`; otherwise the instruction goes as-is. |
| Architecture | New parallel subsystem (approach A): `propose_delegate` tool + pure `delegate.ts` in core + task registry in app. `launcher.ts` untouched. |

## Architecture

### `@bean/core` — `delegate.ts` (new; sibling of `launcher.ts`; zero Electron)

```ts
export interface DelegateRequest {
  cli: "claude" | "opencode";
  projectPath: string;
  prompt: string;
}
```

- **`delegateCommand(req)`** — pure mapping to `{ command, args }`:
  - `claude`: `claude -p <prompt> --output-format stream-json --verbose
    --allowedTools Bash,Edit,Write,Read,Glob,Grep`. stream-json gives a live tail
    (assistant/tool events) and a machine-readable final `result` event.
  - `opencode`: `opencode run <prompt>` with `cwd: projectPath`. Plain stdout is the
    tail; accumulated stdout is the result.
- **`runDelegate(req, callbacks, spawnFn)`** → `{ cancel(): void }`.
  - `callbacks: { onOutput(line: string), onDone(result: string), onError(err: Error) }`.
  - Spawns via a DI'd spawn function (same pattern as `LaunchSpawnFn`), with
    `cwd: projectPath` and a detached process group so `cancel()` can kill the tree.
  - Parses claude stream-json lines into short human-readable tail lines; opencode
    stdout passes through as-is.
  - Collects the final result: claude's `result` event, or accumulated stdout as
    fallback (also the opencode path).
  - 30-minute safety timeout → kill + `onError`.

### `@bean/app` — wiring

- **`delegate-tasks.ts`** (new, main process): task registry
  `Map<taskId, { cancel, lastEvent, meta }>`. Starts tasks via `runDelegate`, pushes
  lifecycle events to the renderer with `webContents.send`, and **buffers each task's
  latest event** so a re-subscribing renderer (window closed/reopened) gets current
  state replayed. Handler-builder functions (`buildDelegateStartHandler`, …) are
  separable from Electron for tests, like `ipc.ts`'s existing builders.
- **`channels.ts`**: `bean:delegate-start` (invoke), `bean:delegate-cancel` (invoke),
  `bean:delegate-event` (main → renderer push; Bean's first push channel).
- **Preload**: `window.bean.delegate = { start, cancel, onEvent }` (types in `bean.d.ts`).
- **Settings**: "Delegate CLI" picker (claude/opencode) fed by `detectClis()`, alongside
  the terminal/editor pickers. Stored in runtime config; default = first detected CLI.

### `converse()` — the tool

- New confirm-first tool **`propose_delegate`** offered whenever ≥1 project exists and a
  delegate CLI is available (availability passed in by `main.ts`):
  - `project` (enum of project paths, required), `instruction` (string, required),
    `skill` (enum of skill names, **optional**).
  - Short-circuits out of the tool loop like `propose_run`, as
    `proposedDelegate: ProposedDelegate` on `ConverseResult`
    (`{ projectPath, instruction, skillName?, composedPrompt }`).
  - Validation mirrors `propose_run`: unknown project → drop the proposal, return the
    text reply; unknown skill → treat as no skill (instruction as-is).
- `BEHAVIOR_INSTRUCTIONS` update: distinguish "user wants an interactive session in
  their terminal" (`propose_run`) from "user wants Bean to get it done and report back"
  (`propose_delegate`); prefer delegate when the user phrases it as an outcome request.

## Data flow (round trip)

1. User asks for something complex → `bean:chat` → `converse()`.
2. Model calls `propose_delegate` → validated → `proposedDelegate` in `ConverseResult`.
3. ChatWindow renders a **DelegateCard** in *proposal* state (project, instruction,
   skill if any; confirm / dismiss).
4. Confirm → `window.bean.delegate.start(...)` → registry assigns `taskId`, resolves the
   CLI from settings, calls `runDelegate`. Card → *running* state (elapsed time, live
   tail via `bean:delegate-event`, cancel button).
5. On `done`: card → *finished* state (collapsed result, expandable). The renderer then
   sends the result back through the normal chat flow as a collapsed tool-result turn —
   same `ChatItem.display` collapse mechanism chat-target skills use — with content
   `[delegate result for <instruction>]: <result>`. Bean's model replies in its own
   voice; the result is now in history, so follow-up delegations can chain.
6. Cancel → `bean:delegate-cancel(taskId)` → process-group kill → *cancelled* state.

## Error handling

- **CLI missing / spawn error** (ENOENT): `failed` event with a clear message
  ("claude not found on PATH"). `loginShellPath()` already widens PATH at startup.
- **Non-zero exit**: `failed` event carrying the stderr tail.
- **Stream parse failures**: unparsable stream-json lines degrade to raw tail text;
  a missing final `result` event falls back to accumulated stdout.
- **Timeout** (30 min): kill + `failed("timed out")`.
- **Invalid tool args** in `converse()`: proposal dropped, text reply returned
  (mirrors `propose_run`).
- **Window closed mid-run**: task keeps running in main; buffered last-event replay on
  re-subscribe brings a reopened window current.

## Testing

- **core `delegate.test.ts`**: `delegateCommand` mapping for both CLIs (flags, prompt as
  a single token); `runDelegate` with a fake child process — stream-json parsing → tail
  lines, final result extraction, stdout fallback, cancel kills the process group,
  ENOENT/non-zero-exit → `onError`, timeout.
- **core `converse.test.ts`** additions: `propose_delegate` happy path (with and without
  skill), skill composition via `composePrompt`, invalid project → proposal dropped,
  tool absent when no delegate CLI is available.
- **app `ipc`/`delegate-tasks` tests**: handler builders exercised without Electron —
  start assigns ids and forwards events, cancel routes to the right task, last-event
  replay on subscribe.
- Gate: `pnpm test && pnpm typecheck` green.

## Out of scope (YAGNI)

- Session continuation (`claude -p --resume`) — a future follow-up; the loopback turn
  already enables conversational chaining.
- Cost/token reporting, run history persistence, parallel-task orchestration UI.
- Letting the chat model choose the harness per-task.
- Any change to `launcher.ts` / the Terminal launch path.

## Memory note

`convention-launch-hands-off-to-terminal.md` stays true for Terminal launches but must be
updated to say delegation is the deliberate exception (tracked, streamed, cancellable).
Add a `convention-delegate-loopback.md` entry in the same change as the implementation.
