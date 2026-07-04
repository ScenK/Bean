# SP3 Console Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Bean's placeholder Console panel into a live terminal view of the current `opencode run` — status chip, `skill · project`, elapsed timer, `$ opencode run …` echo, ANSI-colored streamed output, and a blinking caret.

**Architecture:** ANSI parsing is pure logic in a new `@bean/core` module (`terminal.ts`, built on the `anser` library) that reduces the raw stdout/stderr stream into a styled `TerminalLine[]` model. The renderer stays thin: `App` captures run metadata at confirm time and feeds the existing (SP2-ignored) `stdout`/`stderr`/`status` events into the reducer; `ConsolePanel` renders the model. No change to `runOpencode` or the `bean:run` IPC path.

**Tech Stack:** TypeScript (ESM), `@bean/core` (tsc, pure), `@bean/app` (Electron, esbuild, Preact), `anser` (ANSI→JSON), Vitest.

**Spec:** [docs/superpowers/specs/2026-06-30-bean-console-panel-design.md](../specs/2026-06-30-bean-console-panel-design.md)

## Global Constraints

- `@bean/core` stays pure and Electron-free, dependency-injected — new IO/logic goes there, not in `app/` (`.memory/convention-core-is-electron-free.md`).
- **No change** to `runOpencode`, `packages/core/src/runner.ts`, the `bean:run` IPC, `channels.ts`, `preload.ts`, or `bean.d.ts`. SP3 only *consumes* `stdout`/`stderr`/`status` `RunEvent`s that already flow.
- ESM everywhere: `.js` extensions in relative imports; `import type` for type-only imports (`verbatimModuleSyntax` is on).
- `strict` + `noUncheckedIndexedAccess` are on — array access is `T | undefined`; handle it.
- No new test-framework dependency. Pure logic (core `terminal.ts`) is unit-tested with Vitest; renderer UI is verified manually via `pnpm dev`.
- Console terminal body is **dark in both** Hearth and Graphite themes; only the panel header follows the theme.
- The chat's status bubbles stay exactly as SP2 built them — SP3 *adds* console handling alongside them, it does not replace them.
- Requires Node ≥24, pnpm 11, `opencode` on `PATH`.
- Validation gate: `pnpm test && pnpm typecheck` from the repo root, both exit 0.

---

### Task 1: Core ANSI terminal reducer (`@bean/core`)

**Files:**
- Modify: `packages/core/package.json` (add `anser` dependency)
- Create: `packages/core/src/terminal.ts`
- Modify: `packages/core/src/index.ts:9` (add re-export)
- Test: `packages/core/__test__/terminal.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks; `anser`'s `Anser.ansiToJson(text): { content: string; fg: string; bg: string; decorations: ("bold"|"dim"|...)[]; was_processed: boolean }[]`.
- Produces (later tasks rely on these exact names/types):
  - `interface TerminalSegment { text: string; fg?: string; bg?: string; bold?: boolean; dim?: boolean; stream: "stdout" | "stderr" }`
  - `interface TerminalLine { segments: TerminalSegment[] }`
  - `interface TerminalState { lines: TerminalLine[]; sgr: SgrState }` (`SgrState` internal, not exported)
  - `function emptyTerminal(): TerminalState`
  - `function appendChunk(state: TerminalState, text: string, stream: "stdout" | "stderr"): TerminalState`
  - `function cssColor(anser: string | null | undefined): string | undefined`

- [x] **Step 1: Add the `anser` dependency**

Run:
```bash
pnpm --filter @bean/core add anser
```
Expected: `packages/core/package.json` `dependencies` gains `"anser": "^2.3.5"` (or similar); pnpm lockfile updates; exit 0.

- [x] **Step 2: Write the failing test**

Create `packages/core/__test__/terminal.test.ts`:
```typescript
import { expect, test } from "vitest";
import { appendChunk, cssColor, emptyTerminal } from "../src/terminal.js";

const RED = "rgb(187, 0, 0)"; // anser maps SGR 31 → "187, 0, 0"

test("cssColor wraps anser rgb triples and passes through null", () => {
  expect(cssColor("187, 0, 0")).toBe(RED);
  expect(cssColor(null)).toBeUndefined();
  expect(cssColor(undefined)).toBeUndefined();
});

test("plain text splits on newlines into one line each", () => {
  const s = appendChunk(emptyTerminal(), "hello\nworld", "stdout");
  expect(s.lines).toHaveLength(2);
  expect(s.lines[0]?.segments).toEqual([{ text: "hello", stream: "stdout" }]);
  expect(s.lines[1]?.segments).toEqual([{ text: "world", stream: "stdout" }]);
});

test("SGR color applies to text and clears on reset", () => {
  const s = appendChunk(emptyTerminal(), "\x1b[31mred\x1b[0m plain", "stdout");
  const segs = s.lines[0]?.segments ?? [];
  expect(segs[0]).toEqual({ text: "red", fg: RED, stream: "stdout" });
  expect(segs[1]).toEqual({ text: " plain", stream: "stdout" });
});

test("bold and dim decorations become flags", () => {
  const s = appendChunk(emptyTerminal(), "\x1b[1mB\x1b[0m\x1b[2mD", "stdout");
  const segs = s.lines[0]?.segments ?? [];
  expect(segs[0]).toEqual({ text: "B", bold: true, stream: "stdout" });
  expect(segs[1]).toEqual({ text: "D", dim: true, stream: "stdout" });
});

test("SGR color carries across chunks until reset", () => {
  const s1 = appendChunk(emptyTerminal(), "\x1b[31mred", "stdout");
  const s2 = appendChunk(s1, " more\x1b[0m done", "stdout");
  const segs = s2.lines[0]?.segments ?? [];
  expect(segs[0]).toEqual({ text: "red", fg: RED, stream: "stdout" });
  expect(segs[1]).toEqual({ text: " more", fg: RED, stream: "stdout" });
  expect(segs[2]).toEqual({ text: " done", stream: "stdout" });
});

test("carriage return clears the current line", () => {
  const s = appendChunk(emptyTerminal(), "aaaa\rbb", "stdout");
  expect(s.lines).toHaveLength(1);
  expect(s.lines[0]?.segments).toEqual([{ text: "bb", stream: "stdout" }]);
});

test("carriage return clears text written by an earlier chunk", () => {
  const s1 = appendChunk(emptyTerminal(), "Working...", "stdout");
  const s2 = appendChunk(s1, "\rDone", "stdout");
  expect(s2.lines[0]?.segments).toEqual([{ text: "Done", stream: "stdout" }]);
});

test("stderr chunks are tagged", () => {
  const s = appendChunk(emptyTerminal(), "oops", "stderr");
  expect(s.lines[0]?.segments[0]?.stream).toBe("stderr");
});

test("retained lines are capped at MAX_LINES (2000), newest kept", () => {
  const text = Array.from({ length: 2500 }, (_, i) => `line${i}`).join("\n");
  const s = appendChunk(emptyTerminal(), text, "stdout");
  expect(s.lines).toHaveLength(2000);
  expect(s.lines[s.lines.length - 1]?.segments[0]?.text).toBe("line2499");
});

test("appendChunk does not mutate the input state", () => {
  const before = emptyTerminal();
  appendChunk(before, "x", "stdout");
  expect(before.lines).toHaveLength(1);
  expect(before.lines[0]?.segments).toHaveLength(0);
});
```

- [x] **Step 3: Run the test to verify it fails**

Run:
```bash
pnpm --filter @bean/core exec vitest run __test__/terminal.test.ts
```
Expected: FAIL — `Failed to resolve import "../src/terminal.js"` (the module doesn't exist yet).

- [x] **Step 4: Implement the reducer**

Create `packages/core/src/terminal.ts`:
```typescript
import Anser from "anser";

export interface TerminalSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  stream: "stdout" | "stderr";
}

export interface TerminalLine {
  segments: TerminalSegment[];
}

interface SgrState {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
}

export interface TerminalState {
  lines: TerminalLine[];
  sgr: SgrState;
}

const RESET: SgrState = { bold: false, dim: false };

// ponytail: caps retained scrollback so a chatty run can't grow unbounded;
// raise MAX_LINES (or add SP6 scrollback persistence) if a long run truncates.
const MAX_LINES = 2000;

export function cssColor(anser: string | null | undefined): string | undefined {
  return anser ? `rgb(${anser})` : undefined;
}

export function emptyTerminal(): TerminalState {
  return { lines: [{ segments: [] }], sgr: { ...RESET } };
}

function styleSegment(style: SgrState): Omit<TerminalSegment, "text" | "stream"> {
  const seg: Omit<TerminalSegment, "text" | "stream"> = {};
  if (style.fg) seg.fg = style.fg;
  if (style.bg) seg.bg = style.bg;
  if (style.bold) seg.bold = true;
  if (style.dim) seg.dim = true;
  return seg;
}

function writeRun(
  lines: TerminalLine[],
  content: string,
  style: SgrState,
  stream: "stdout" | "stderr",
): void {
  // Split on newlines; a \r within a part clears the current line (spinner redraw).
  const parts = content.split("\n");
  parts.forEach((part, idx) => {
    if (idx > 0) lines.push({ segments: [] });
    const current = lines[lines.length - 1]!;
    let text = part;
    if (text.includes("\r")) {
      // ponytail: \r = clear-line (only latest redraw shown); column-addressed
      // partial overwrite is the upgrade path if a tool needs it.
      current.segments = [];
      text = text.slice(text.lastIndexOf("\r") + 1);
    }
    if (text) current.segments.push({ text, ...styleSegment(style), stream });
  });
}

export function appendChunk(
  state: TerminalState,
  text: string,
  stream: "stdout" | "stderr",
): TerminalState {
  const lines: TerminalLine[] = state.lines.map((l) => ({ segments: [...l.segments] }));
  // anser does not carry SGR onto a fresh call's leading text, so we carry it
  // ourselves: `running` starts from the previous chunk's trailing style and is
  // updated whenever anser reports a real SGR change (`was_processed`).
  let running: SgrState = { ...state.sgr };
  for (const tok of Anser.ansiToJson(text)) {
    if (tok.was_processed) {
      running = {
        fg: cssColor(tok.fg),
        bg: cssColor(tok.bg),
        bold: tok.decorations.includes("bold"),
        dim: tok.decorations.includes("dim"),
      };
    }
    if (tok.content) writeRun(lines, tok.content, running, stream);
  }

  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  return { lines, sgr: running };
}
```

> **Deviation found during build (flagged, not silent):** the `for (const tok of ...) { if (tok.was_processed) ... }`
> gate above never fires on a reset (`\x1b[0m`). anser's `was_processed` is `false` whenever the *resulting*
> style is default — including a reset — not just when there's no escape at all (verified against the
> installed `anser@2.3.5` source, `lib/index.js:481-497`). This silently failed 2 of the 10 tests (color
> leaking past a reset). Fix applied in the actual `terminal.ts`: use the token's **index** in the array
> instead of `was_processed` — every token after the first was, by construction of `Anser.process()`
> (`txt.split(/\033\[/)`), preceded by a real escape, so `i > 0` is the reliable "SGR changed" signal
> (index 0 is always the pre-escape leading text and should keep the carried style). See the `ponytail:`
> comment in `packages/core/src/terminal.ts` for the inline version of this note.

- [x] **Step 5: Add the re-export**


In `packages/core/src/index.ts`, add after line 9 (`export * from "./runner.js";`):
```typescript
export * from "./terminal.js";
```

- [x] **Step 6: Run the test to verify it passes**

Run:
```bash
pnpm --filter @bean/core exec vitest run __test__/terminal.test.ts
```
Expected: PASS — all 10 tests green.

- [x] **Step 7: Typecheck core**

Run:
```bash
pnpm --filter @bean/core exec tsc -p tsconfig.json --noEmit
```
Expected: exit 0, no errors.

- [x] **Step 8: Commit**

```bash
git add packages/core/package.json packages/core/src/terminal.ts packages/core/src/index.ts packages/core/__test__/terminal.test.ts pnpm-lock.yaml
git commit -m "feat(core): add ANSI terminal reducer for console stream"
```

---

### Task 2: Console panel component + terminal styling (`@bean/app`)

**Files:**
- Modify: `packages/app/src/renderer/dashboard/panels/ConsolePanel.tsx` (replace the placeholder)
- Modify: `packages/app/src/renderer/theme.css` (add console color tokens to both themes)
- Modify: `packages/app/src/renderer/dashboard.css` (append console styles)

**Interfaces:**
- Consumes: `TerminalLine` / `TerminalSegment` from `@bean/core` (Task 1).
- Produces: `ConsolePanel` accepting optional props
  `{ run?: { skillName: string; projectPath: string; prompt: string }; lines?: TerminalLine[]; status?: "idle" | "running" | "done" | "failed"; startedAt?: number }`.
  All props are optional so `<ConsolePanel />` (App's current call) still typechecks until Task 3 wires it.

- [x] **Step 1: Replace `ConsolePanel.tsx`**

Overwrite `packages/app/src/renderer/dashboard/panels/ConsolePanel.tsx`:
```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import { PanelHeader } from "../Panel.js";
import type { TerminalLine } from "@bean/core";

type RunStatus = "idle" | "running" | "done" | "failed";

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ConsolePanel({
  run,
  lines = [],
  status = "idle",
  startedAt,
}: {
  run?: { skillName: string; projectPath: string; prompt: string };
  lines?: TerminalLine[];
  status?: RunStatus;
  startedAt?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());

  // Tick the elapsed timer only while running.
  // ponytail: frozen elapsed is last-tick precision (±1s); fine for a run monitor.
  useEffect(() => {
    if (status !== "running") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  // Auto-scroll to the bottom on new output.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, status]);

  if (status === "idle") {
    return (
      <div class="bean-panel">
        <PanelHeader title="opencode · run" />
        <div class="bean-panel-empty">No run yet — confirm a proposal in chat to see output here.</div>
      </div>
    );
  }

  const elapsed = startedAt !== undefined ? formatElapsed(now - startedAt) : "0:00";

  return (
    <div class="bean-panel">
      <PanelHeader title="opencode · run" />
      <div class="bean-console" ref={scrollRef}>
        <div class="bean-console-bar">
          <span class={`bean-console-chip bean-console-chip--${status}`}>
            {status === "running" ? <span class="bean-console-dot" /> : null}
            {status}
          </span>
          {run ? <span class="bean-console-meta">{run.skillName} · {basename(run.projectPath)}</span> : null}
          <span class="bean-console-spacer" />
          <span class="bean-console-time">{elapsed}</span>
        </div>
        {run ? (
          <div class="bean-console-cmd">$ opencode run "{run.prompt}" --dir {run.projectPath}</div>
        ) : null}
        {lines.map((line, i) => (
          <div key={i} class="bean-console-line">
            {line.segments.length === 0
              ? "\u00a0"
              : line.segments.map((seg, j) => (
                  <span
                    key={j}
                    class={seg.stream === "stderr" ? "bean-console-stderr" : undefined}
                    style={{
                      color: seg.fg,
                      background: seg.bg,
                      fontWeight: seg.bold ? 700 : undefined,
                      opacity: seg.dim ? 0.6 : undefined,
                    }}
                  >
                    {seg.text}
                  </span>
                ))}
          </div>
        ))}
        {status === "running" ? <span class="bean-console-caret" /> : null}
      </div>
    </div>
  );
}
```

- [x] **Step 2: Add console color tokens to both themes**

In `packages/app/src/renderer/theme.css`, inside the `:root[data-theme="hearth"]` block (after line 16, before its closing `}`), add:
```css
  --bean-console-bg: oklch(0.205 0.018 60);
  --bean-console-fg: oklch(0.82 0.02 80);
  --bean-console-cmd: oklch(0.74 0.12 52);
  --bean-console-meta: oklch(0.6 0.02 70);
```
And inside the `:root[data-theme="graphite"]` block (after line 34, before its closing `}`), add:
```css
  --bean-console-bg: oklch(0.165 0.015 270);
  --bean-console-fg: oklch(0.8 0.02 240);
  --bean-console-cmd: oklch(0.78 0.1 235);
  --bean-console-meta: oklch(0.55 0.02 260);
```

- [x] **Step 3: Append console styles**

Append to the end of `packages/app/src/renderer/dashboard.css`:
```css
/* --- console (SP3) --- */
.bean-console {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--bean-console-bg);
  color: var(--bean-console-fg);
  padding: 14px 16px;
  font: 12.5px/1.65 ui-monospace, SFMono-Regular, monospace;
}
.bean-console-bar {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 12px;
}
.bean-console-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  border-radius: 999px;
  padding: 3px 9px;
}
.bean-console-chip--running { background: oklch(0.32 0.06 50); color: oklch(0.85 0.1 60); }
.bean-console-chip--done { background: oklch(0.3 0.05 150); color: oklch(0.85 0.12 155); }
.bean-console-chip--failed { background: oklch(0.32 0.09 25); color: oklch(0.85 0.13 30); }
.bean-console-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: bean-console-blink 1.1s infinite;
}
.bean-console-meta { color: var(--bean-console-meta); }
.bean-console-spacer { flex: 1; }
.bean-console-time { color: var(--bean-console-meta); font-variant-numeric: tabular-nums; }
.bean-console-cmd {
  color: var(--bean-console-cmd);
  margin-bottom: 2px;
  white-space: pre-wrap;
  word-break: break-word;
}
.bean-console-line {
  white-space: pre-wrap;
  word-break: break-word;
}
.bean-console-stderr { color: oklch(0.78 0.12 25); }
.bean-console-caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  background: var(--bean-console-fg);
  vertical-align: -2px;
  animation: bean-console-caret 1s step-end infinite;
}
@keyframes bean-console-blink { 50% { opacity: 0.25; } }
@keyframes bean-console-caret { 50% { opacity: 0; } }
```

- [x] **Step 4: Typecheck + build the app**

Run:
```bash
pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit && pnpm --filter @bean/app build
```
Expected: exit 0. `ConsolePanel`'s props are all optional, so App's existing `<ConsolePanel />` (unchanged in this task) still typechecks.

- [x] **Step 5: Commit**

```bash
git add packages/app/src/renderer/dashboard/panels/ConsolePanel.tsx packages/app/src/renderer/theme.css packages/app/src/renderer/dashboard.css
git commit -m "feat(app): build ConsolePanel terminal view + console styles"
```

---

### Task 3: Wire run stream into `App` and pass to the console

**Files:**
- Modify: `packages/app/src/renderer/dashboard/App.tsx`
- Modify: `packages/core/package.json` (add a node-free `./terminal` subpath export)

**Interfaces:**
- Consumes: `emptyTerminal`, `appendChunk`, `TerminalState` from `@bean/core` (Task 1); `ConsolePanel`'s prop shape (Task 2).
- Produces: nothing downstream (terminal task in the plan).

> **Deviation found during build (flagged, not silent):** every prior renderer import from
> `@bean/core` was `import type` (erased at compile time — see `ProposalCard.tsx`, `chat-types.ts`,
> `ChatPanel.tsx`, `bean.d.ts`). Step 1's `import { appendChunk, emptyTerminal, ... } from "@bean/core"`
> is the first *value* import, which forces esbuild to resolve `@bean/core`'s barrel `index.ts` —
> including `config.js`/`skill-library.js`/`project-registry.js`/`runner.js`, which import
> `node:fs/promises`/`node:os`/`node:path`/`node:child_process`. The renderer bundle
> (`esbuild.config.mjs`) builds with `platform: "browser"` and loads via
> `<script type="module">` with `contextIsolation: true`/`nodeIntegration: false`
> (`windows.ts:13`) — no Node module resolution is available there.
>
> First attempt (marking those builtins `external` in the renderer esbuild call) made the build
> pass but was wrong: esbuild leaves external imports as literal `import ... from "node:..."`
> statements in the output rather than inlining or removing them, and those would throw
> `Failed to resolve module specifier` the instant Chromium's native module loader tried to load
> the bundle — confirmed by inspecting `dist/renderer/dashboard.js` and reverted.
>
> Actual fix: added a `./terminal` subpath export to `packages/core/package.json` pointing
> directly at `dist/terminal.js`/`dist/terminal.d.ts` (which only depends on `anser`, no
> node/electron), and changed Step 1's value import to
> `from "@bean/core/terminal"` (the type-only import stays `from "@bean/core"`, since type
> imports are erased and never reach esbuild). This keeps every node-touching module out of the
> renderer's resolve graph entirely, rather than deferring the failure to runtime. Confirmed with
> `grep -c "node:fs\|node:os\|node:path\|node:child_process" dist/renderer/dashboard.js` → `0`,
> while `dist/main.js` (which legitimately runs under Node) still contains them.

- [x] **Step 1: Add core value/type imports**

In `packages/app/src/renderer/dashboard/App.tsx`, replace line 11:
```typescript
import type { ChatTurn, RouteSuggestion, RunEvent } from "@bean/core";
```
with (actual: value import from the node-free `./terminal` subpath, see deviation note above):
```typescript
import { appendChunk, emptyTerminal, type TerminalState } from "@bean/core/terminal";
import type { ChatTurn, RouteSuggestion, RunEvent } from "@bean/core";
```

- [x] **Step 2: Add console state**

In `App`, immediately after line 21 (`const [activity, setActivity] = useState<OrbState>("idle");`), add:
```typescript
  const [currentRun, setCurrentRun] = useState<{ skillName: string; projectPath: string; prompt: string } | undefined>(undefined);
  const [terminal, setTerminal] = useState<TerminalState>(() => emptyTerminal());
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
```

- [x] **Step 3: Extend the run-event handler**

Replace the `window.bean.onRunEvent(...)` call (currently `App.tsx:29-42`) with:
```typescript
    window.bean.onRunEvent((ev: RunEvent) => {
      if (ev.type === "stdout") {
        setTerminal((s) => appendChunk(s, ev.text, "stdout"));
        return;
      }
      if (ev.type === "stderr") {
        setTerminal((s) => appendChunk(s, ev.text, "stderr"));
        return;
      }
      // ev.type === "status" — chat bubbles (SP2) plus console lifecycle (SP3)
      if (ev.status === "running") {
        setTerminal(emptyTerminal());
        setRunStatus("running");
        setStartedAt(Date.now());
        setItems((prev) => [...prev, { kind: "status", id: newId(), text: "Spinning up…", tone: "info" }]);
        setActivity("working");
      } else if (ev.status === "done") {
        setRunStatus("done");
        setItems((prev) => [...prev, { kind: "status", id: newId(), text: "Done.", tone: "done" }]);
        setActivity("done");
        setTimeout(() => setActivity("idle"), 1500);
      } else {
        setRunStatus("failed");
        setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Failed${ev.message ? ": " + ev.message : ""}`, tone: "error" }]);
        setActivity("idle");
      }
    });
```

- [x] **Step 4: Record run metadata on confirm**

In `confirmProposal` (currently `App.tsx:78-81`), replace the body with:
```typescript
  const confirmProposal = (id: string, editedPrompt: string, run: RouteSuggestion): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "proposal" ? { ...it, state: "confirmed" } : it)));
    setCurrentRun({ skillName: run.skillName, projectPath: run.projectPath, prompt: editedPrompt });
    void window.bean.run({ ...run, composedPrompt: editedPrompt });
  };
```

- [x] **Step 5: Pass props to `ConsolePanel`**

Replace `<ConsolePanel />` (currently `App.tsx:93`) with:
```tsx
        <ConsolePanel run={currentRun} lines={terminal.lines} status={runStatus} startedAt={startedAt} />
```

- [x] **Step 6: Typecheck + build the app**

Run:
```bash
pnpm --filter @bean/app exec tsc -p tsconfig.json --noEmit && pnpm --filter @bean/app build
```
Expected: exit 0.

- [x] **Step 7: Commit**

```bash
git add packages/app/src/renderer/dashboard/App.tsx
git commit -m "feat(app): stream run output into the console panel"
```

---

### Task 4: Full validation gate + manual verification + ledger update

**Files:**
- Modify: `docs/superpowers/bean-redesign-playbook.md` (status ledger row for SP3)
- Modify: `.memory/project-dashboard-redesign-roadmap.md` (status line)
- Check off completed step boxes in this plan file.

**Interfaces:** none.

- [x] **Step 1: Run the full repo gate**

Run:
```bash
pnpm test && pnpm typecheck
```
Expected: both turbo tasks succeed, exit 0. (`@bean/core` includes the new `terminal.test.ts`; both packages typecheck.)

Actual: both exit 0 — `@bean/core` 9 test files / 40 tests passed (incl. the new 10 in
`terminal.test.ts`), `@bean/app` 2 test files / 6 tests passed, both packages' `tsc --noEmit`
clean. A fresh `pnpm --filter @bean/app build` (esbuild) also passed, confirming the Task 3
deviation fix.

- [ ] **Step 2: Manual walkthrough via `pnpm dev`**

Requires `~/.bean/config.json` with a real `openaiApiKey`, at least one skill in `~/.bean/skills/*.md`, and a project in `~/.bean/projects.json` whose `path` is a real directory with `opencode` runnable. Run:
```bash
pnpm dev
```
Verify each, checking the box only after observing it:
- [ ] Before any run: the console shows the empty-state placeholder ("No run yet — …").
- [ ] Confirm a proposal that triggers a real `opencode run` → console shows the `running` chip (with animated dot), `skill · project`, a ticking `m:ss` timer, the `$ opencode run "…" --dir …` echo, and streamed output appearing live with a blinking caret.
- [ ] Output containing color renders colored (not raw `ESC[` codes, not monochrome).
- [ ] Any stderr output is visually distinct (reddish).
- [ ] Run completes → chip flips to `done`, caret disappears, timer freezes.
- [ ] A failing run (e.g. temporarily point a project at a bad path) → chip shows `failed`; the chat still shows its failure bubble as before.
- [ ] Start a second run → the console resets and streams the new run only.
- [ ] Toggle Hearth/Graphite (title-bar button) → the terminal body stays dark in both; only the header restyles.

> If your environment cannot exercise a real `opencode` subprocess, note that explicitly and confirm the reducer via the Task 1 tests plus a visual check of the empty/idle state instead.

> **Actual (builder session, left unchecked above — not observed):** the runtime setup was real
> (`~/.bean/config.json` has a live `openaiApiKey`, `~/.bean/skills/echo.md` exists,
> `~/.bean/projects.json` points `bean` at a real directory, `opencode` is on `PATH`), so `pnpm dev`
> was launched and produced a clean multi-process Electron start (main/gpu/renderer/network,
> confirmed via `ps aux`) with no crash — indirect confirmation the Task 3 deviation fix actually
> works at runtime (a broken fix would have thrown `Failed to resolve module specifier` the instant
> `dashboard.js` loaded). Beyond that, this agent session has **no GUI-automation or screenshot
> tool** to click the avatar, drop a URL, confirm a proposal, or read pixel-level chip/color/timer
> state, so none of the interactive checklist items above could be *observed* and are left
> unchecked rather than guessed. Substituted verification: (1) all 10 `terminal.test.ts` cases
> (Task 1) exercise the exact reducer logic the console renders — SGR color, reset, bold/dim,
> cross-chunk carry, `\r` redraw, stderr tagging, `MAX_LINES` cap, immutability; (2) static review
> of `ConsolePanel.tsx`'s `status === "idle"` branch confirms it renders the empty-state placeholder
> text exactly as specified. A human (or an agent with display/automation access) still needs to
> run the interactive checklist before this is fully signed off.


- [x] **Step 3: Update the status ledger**

In `docs/superpowers/bean-redesign-playbook.md`, change the SP3 row (line 22) to reference the spec/plan and mark it done:
```markdown
| 3 | Console panel: live terminal view of the current `opencode run` — status chip, elapsed timer, command echo, ANSI-colored stdout/stderr stream | `specs/2026-06-30-bean-console-panel-design.md` | `plans/2026-06-30-bean-console-panel.md` | ✅ done + reviewed |
```

- [x] **Step 4: Update the roadmap memory**

In `.memory/project-dashboard-redesign-roadmap.md`, update the "Status at last update" line to reflect SP3 complete (SP1–SP3 done; SP4–SP6 not started), noting SP3 added the `@bean/core` `terminal.ts` ANSI reducer (with the `anser` dependency) consumed by the renderer console, with no change to the run IPC path.

- [x] **Step 5: Check off this plan's step boxes**

Mark every completed `- [ ]` in this plan file as `- [x]`.

- [x] **Step 6: Commit**

```bash
git add docs/superpowers/bean-redesign-playbook.md .memory/project-dashboard-redesign-roadmap.md docs/superpowers/plans/2026-06-30-bean-console-panel.md
git commit -m "docs(sp3): mark console panel done and update ledger"
```

---

## Self-Review

**Spec coverage:**
- §4.1 core reducer (`emptyTerminal`/`appendChunk`/`cssColor`, `\n`/`\r`, SGR carry, cap, anser) → Task 1.
- §4.2 App state + event wiring (`currentRun`, terminal feed, reset on running, status/startedAt) → Task 3.
- §4.3 ConsolePanel (chip, timer, command echo, segments, caret, auto-scroll, empty state) → Task 2.
- §4.4 CSS (dark-in-both-themes tokens, chip, caret, stderr, tabular-nums) → Task 2.
- §6 tests → Task 1 (`terminal.test.ts`); renderer manual → Task 4.
- §7 manual checklist → Task 4 Step 2.
- "No change to runner/IPC" → Global Constraints; no task touches those files.

**Placeholder scan:** none — every code step shows full content; commands and expected outputs are concrete.

**Type consistency:** `TerminalState`/`TerminalLine`/`TerminalSegment`, `emptyTerminal`, `appendChunk`, `cssColor` names match across Tasks 1→2→3. `ConsolePanel` props (`run`/`lines`/`status`/`startedAt`) are defined optional in Task 2 and passed in Task 3. The `run` object shape `{ skillName, projectPath, prompt }` matches between `confirmProposal` (Task 3 Step 4) and the `ConsolePanel` prop (Task 2). `RunStatus` union identical in both App state and ConsolePanel.
