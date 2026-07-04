# Bean — Dashboard Redesign, Sub-Project 3: Console Panel — Design

Date: 2026-06-30
Status: Approved for planning
Depends on: [2026-06-30-bean-command-bar-chat-design.md](2026-06-30-bean-command-bar-chat-design.md) (SP2, complete)
Roadmap: [.memory/project-dashboard-redesign-roadmap.md](../../../.memory/project-dashboard-redesign-roadmap.md)

## 1. Summary

Turn the placeholder Console panel into a live terminal view of the current `opencode run`.
The runner already emits `stdout`/`stderr`/`status` `RunEvent`s (`packages/core/src/runner.ts`),
but SP2 deliberately ignored `stdout`/`stderr` in the renderer and surfaced only `status` as
chat bubbles. SP3 consumes that raw stream: it renders a dark terminal box mirroring the
mockup — a status chip (`running`/`done`/`failed` + `skill · project` + elapsed timer), a
synthesized `$ opencode run …` command echo, ANSI-colored streamed output, and a blinking
caret while running.

ANSI escape codes in the stream are parsed into colored spans. The parsing is pure logic and
lives in `@bean/core` as a stateful terminal reducer (built on the `anser` library);
the renderer stays a thin view. **No change to `runner.ts` or the run IPC path is needed** —
only new consumption of events that already flow.

## 2. Key decisions (locked in brainstorming)

| Decision | Choice |
|---|---|
| Run scope | Single current run. A new run (`status: running`) resets the console; SP6 owns multi-run history. |
| ANSI handling | Render ANSI colors (not strip, not raw). |
| ANSI implementation | Add the `anser` dependency to `@bean/core`; wrap it in a pure, stateful terminal reducer that also resolves `\n`/`\r` line semantics (anser only decodes SGR). |
| Where parsing lives | `@bean/core` (pure, Electron-free, unit-tested). Renderer only renders the resulting line/segment model. |
| Run metadata source | Renderer-side. `App` already has `{ skillName, projectPath, composedPrompt }` at confirm time; it stashes them as `currentRun`. No `start` event or core/IPC change. |
| Terminal theming | Console body is dark in **both** Hearth and Graphite (both mockups render it as a real terminal); only the panel header follows the theme. |
| Chat behavior | Unchanged. Status bubbles in chat stay exactly as SP2 built them; `stdout`/`stderr` now additionally feed the console. |
| Concurrency | One run at a time, as today. |

## 3. Scope

**In scope:**
- `@bean/core`: add `anser` dependency; new pure module `terminal.ts` exposing an
  immutable terminal-buffer reducer + types, exported from `index.ts`.
- Renderer `App`: capture `currentRun` metadata on confirm; extend the existing
  `onRunEvent` handler so `stdout`/`stderr` feed the terminal buffer and `running` resets it;
  track `runStatus` and `startedAt`; pass all of this to `ConsolePanel`.
- `ConsolePanel`: full terminal view — status chip, elapsed timer, command echo, ANSI-colored
  segment lines, blinking caret, auto-scroll, empty state.
- CSS for the console terminal (dark body in both themes, status chip, caret, segment colors).

**Out of scope (deferred):**
- Multi-run history / scrollback across runs → SP6.
- Absolute cursor addressing / full terminal emulation (only SGR + `\n`/`\r` handled).
- Copy-to-clipboard, clear button, search, download — add on request.
- Any change to `runOpencode`, the `bean:run` IPC, or the chat's status bubbles.

**Mockup reconciliation:** the mockup's streamed lines are hand-authored, semantically colored
examples (`$ …`, `→ …`, `✓`, `!`). Real `opencode` output is arbitrary text, so SP3 renders
whatever the process emits, coloring it from actual ANSI codes rather than classifying lines.
The synthesized `$ opencode run …` echo and the status chip reproduce the mockup's framing; the
per-line semantic colors are approximated by real ANSI when present.

## 4. Architecture

### 4.1 Core: terminal reducer (new file `packages/core/src/terminal.ts`)

Add `anser` to `@bean/core` dependencies. `anser` decodes SGR (color/bold/dim/reset) into
structured tokens but does **not** understand `\n`/`\r`; the reducer owns line assembly.

Types:
- `TerminalSegment = { text: string; fg?: string; bg?: string; bold?: boolean; dim?: boolean; stream: "stdout" | "stderr" }`
  — `fg`/`bg` are CSS color strings resolved from anser tokens; `stream` lets the renderer
  give uncolored stderr a distinct default.
- `TerminalLine = { segments: TerminalSegment[] }`.
- `TerminalState = { lines: TerminalLine[]; sgr: SgrState }` — `lines` is the rendered model;
  `sgr` carries the active SGR attributes across chunks (an ANSI sequence, or a color that
  applies to subsequent lines, can span event boundaries). `SgrState` is internal
  (fg/bg/bold/dim), not part of the public render model.

Functions (pure, no Electron, no I/O):
- `emptyTerminal(): TerminalState` — `{ lines: [{ segments: [] }], sgr: <reset> }` (always
  at least one "open" current line, which trailing appends extend).
- `appendChunk(state: TerminalState, text: string, stream: "stdout" | "stderr"): TerminalState`
  — returns a new state (immutable; never mutates the input). Algorithm:
  1. `Anser.ansiToJson(text)` → ordered tokens `{ content, fg, bg, decorations }`. **anser
     does not carry SGR onto the leading text of a fresh call** (text before the call's first
     escape is always reported unstyled). So the reducer carries its own resolved
     `SgrState` (`state.sgr`): apply the carried style to leading tokens until the first token
     anser marks `was_processed` (a real SGR change); from that token on, use anser's own
     styles (anser tracks state correctly within a single call). The new `state.sgr` is the
     resolved style of the **last** token when the chunk changed SGR, else the carried style
     unchanged (a chunk with no escapes leaves `sgr` as-is).
  2. Walk each token's `content` char-run by char-run, honoring control chars:
     - `\n` → finalize the current line, push a new empty current line.
     - `\r` → **clear the current line** (set its segments to `[]`). This collapses
       spinner/progress redraws that rewrite the whole line. `ponytail:` comment names that
       column-addressed partial overwrite is the upgrade path.
     - other text → append a `TerminalSegment { text, fg, bg, bold, dim, stream }` to the
       current line, where `fg`/`bg` come from `cssColor(token.fg/bg)` and `bold`/`dim` from
       `token.decorations.includes(...)`.
  3. Drop empty-`text` segments (an escape-only run yields none) but still fold its SGR into
     `state.sgr`.
  4. Cap retained lines to the last `MAX_LINES` (constant `2000`). A `ponytail:` comment names
     the cap and that raising it is the upgrade path if a long run is truncated.
- `cssColor(anser: string | null): string | undefined` — `null`/empty → `undefined`, else
  `rgb(<anser>)` (anser yields `"187, 0, 0"`).
- Exported from `packages/core/src/index.ts` alongside the existing re-exports.

Purity & testability: a fake is not needed — inputs are plain strings. Unit tests feed raw
strings (with embedded escape codes and `\n`/`\r`) and assert on the resulting `lines`.

### 4.2 Renderer: `App` state (packages/app/src/renderer/dashboard/App.tsx)

New state, all ephemeral (cleared when the window closes):
- `currentRun: { skillName: string; projectPath: string; prompt: string } | undefined` — set in
  `confirmProposal` from the confirmed `run` + edited prompt, at the moment `window.bean.run(...)`
  fires. This is the only place run metadata is known; no core/IPC change carries it.
- `terminal: TerminalState` — initialized `emptyTerminal()`.
- `runStatus: "idle" | "running" | "done" | "failed"`.
- `startedAt: number | undefined` — timestamp set when `running` arrives, used for the elapsed timer.

Extend the single existing `onRunEvent` subscription (`App.tsx:29`). The chat status-bubble
logic under `if (ev.type === "status")` is **unchanged**; SP3 adds:
- `ev.type === "status" && ev.status === "running"` → also `setTerminal(emptyTerminal())`
  (reset for the single-run view), `setRunStatus("running")`, `setStartedAt(Date.now())`.
- `ev.type === "status" && ev.status === "done" | "failed"` → also `setRunStatus(ev.status)`
  (freeze; timer stops). `startedAt` is retained so the final elapsed time stays displayed.
- `ev.type === "stdout"` → `setTerminal((s) => appendChunk(s, ev.text, "stdout"))`.
- `ev.type === "stderr"` → `setTerminal((s) => appendChunk(s, ev.text, "stderr"))`.

`appendChunk` must be applied via the functional updater form so streamed chunks accumulate
correctly across rapid events (avoiding a stale-closure drop). `App` passes `currentRun`,
`terminal.lines`, `runStatus`, and `startedAt` to `<ConsolePanel>`.

### 4.3 Renderer: `ConsolePanel` (packages/app/src/renderer/dashboard/panels/ConsolePanel.tsx)

Props: `{ run?: { skillName; projectPath; prompt }, lines: TerminalLine[], status: "idle" | "running" | "done" | "failed", startedAt?: number }`.

Layout (mirrors mockup lines 121–133 / 267–279):
- Reuses `PanelHeader title="opencode · run"`.
- Terminal body: dark background in both themes (a dedicated token, not the theme surface).
- **Status chip** at top (when `status !== "idle"`): a pill — `running` with an animated dot,
  or `done` / `failed`; then `skillName · <basename(projectPath)>`; then an **elapsed timer**
  on the right (`m:ss`). The timer ticks via a `setInterval` (1s) while `status === "running"`,
  computed from `startedAt`; it stops (interval cleared) on `done`/`failed`/unmount.
- **Command echo** line: `$ opencode run "<prompt>" --dir <projectPath>` synthesized from `run`.
- **Output**: one `<div>` per `TerminalLine`; each `TerminalSegment` a `<span>` with inline
  `color`/`background`/`font-weight`/`opacity` from the segment; `stream === "stderr"` segments
  with no explicit `fg` get a reddish default class.
- **Blinking caret** appended after the last line while `status === "running"`.
- **Auto-scroll**: a `useRef` on the scroll container + `useEffect` on `lines` scrolls to
  bottom on new output.
- **Empty state** (`status === "idle"`, no run yet): keeps a placeholder ("No run yet — confirm
  a proposal in chat to see output here.").

### 4.4 CSS (packages/app/src/renderer/dashboard.css)

Add console classes: dark terminal body token (fixed dark in both themes), monospace body,
status-chip pill + animated dot, running caret blink, stderr-default color, tabular-nums for
the timer. Follow the existing `.bean-*` naming and the SP1 theme-variable conventions; the
header stays themed via existing `PanelHeader` styling.

## 5. Error handling

- `status: "failed"` (spawn error or non-zero exit) → chip shows `failed`; any `message` from
  the event is already surfaced in chat (unchanged). The console simply freezes the last output.
- A run producing no stdout before failing → chip + command echo still render; body may be empty.
- Malformed / partial ANSI sequences split across chunks → handled by carrying `sgr` state
  across `appendChunk` calls; a truncated sequence at a chunk boundary continues on the next.
- Extremely chatty runs → bounded by `MAX_LINES`; oldest lines drop.
- `appendChunk` never throws on arbitrary bytes (already-decoded UTF-8 strings from `runner.ts`).

## 6. Testing

**Core (`packages/core/__test__/terminal.test.ts`), plain string inputs:**
- Plain text with `\n` → one `TerminalLine` per line, single stdout segment each.
- An SGR color sequence (e.g. red `\x1b[31m…\x1b[0m`) → segment carries the expected `fg`; text
  after reset has no `fg`.
- Bold / dim SGR → `bold`/`dim` flags set.
- SGR that opens in one `appendChunk` and closes in a later one → styling carries across chunks
  (via `state.sgr`); the second chunk's leading text keeps the color until its reset.
- `\r` overwrite: `"aaaa\rbb"` → the line renders `"bb"` (carriage return clears the line, new
  text starts fresh).
- stderr chunk → segments tagged `stream: "stderr"`.
- More than `MAX_LINES` lines appended → retained count capped to `MAX_LINES`, newest kept.
- `appendChunk` returns a new object and does not mutate the input state.
- `cssColor("187, 0, 0")` → `"rgb(187, 0, 0)"`; `cssColor(null)` → `undefined`.

**App / renderer:** no automated DOM tests (SP1/SP2 constraint — no DOM test infra). Verified
manually via `pnpm dev`.

**Gate:** `pnpm test && pnpm typecheck` from the repo root must both exit 0 before done.

## 7. Manual verification checklist (for the plan's final task)

- Open dashboard, confirm a proposal that triggers a real `opencode run` → the console shows
  the `running` chip with `skill · project`, a ticking timer, the `$ opencode run …` echo, and
  streamed output appearing live with a blinking caret.
- A run whose output contains colors → colors render in the console (not raw escape codes, not
  stripped to monochrome).
- A run that writes to stderr → those lines are visually distinct.
- Run completes → chip flips to `done`, caret disappears, timer freezes at final elapsed.
- A failing run (e.g. bad project path) → chip shows `failed`; chat still shows the failure
  bubble as before.
- Start a second run → the console resets (single-run view) and streams the new run.
- Before any run → the empty-state placeholder shows.
- Toggle Hearth/Graphite → the terminal body stays dark in both; only the header restyles.

## 8. Risks / open questions

- **`\r`/spinner fidelity:** the reducer treats carriage-return as clear-the-current-line (so a
  redrawn spinner/progress line shows only its latest state) and does not handle absolute cursor
  addressing (`ESC[<n>;<m>H`, `ESC[K`, cursor-up). Piped, non-TTY `opencode` output typically
  avoids these, so the common case is covered; partial column overwrite and full emulation are
  deferred and noted as the upgrade path.
- **ANSI-off output:** when `opencode` detects a non-TTY pipe it may emit no color at all; the
  console then renders correct monochrome text. The "render colors" decision is a no-op in that
  case, not a regression.
- **`MAX_LINES` cap:** a very long run loses its earliest lines. The `ponytail:` comment names
  the cap and that raising it (or adding scrollback persistence in SP6) is the upgrade path.
- **`anser` (v2.3.x):** used for SGR decoding only. `Anser.ansiToJson(text)` returns
  `{ content, fg, bg, decorations }[]` (verified: `fg`/`bg` as `"r, g, b"` or null,
  `decorations` including `"bold"`/`"dim"`, `was_processed` flag); it ships its own types
  (`export = Anser`) and default-imports under the repo's `esModuleInterop`. The reducer's own
  `\n`/`\r` and cross-chunk carry logic is independent of the library.
