# Chat Close — Confirm-Before-Extract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the chat window's close-time memory extraction behind an explicit user
confirmation, with a visible loading state while the LLM call is in flight, instead of
silently kicking off extraction on every close.

**Architecture:** `ChatWindow.tsx`'s single nullable `review` state becomes a 3-stage
`closeFlow` state (`confirm` → `loading` → `review`) that drives which card is rendered.
No IPC/channel/main-process changes — `main.ts`'s close-intercept, `extractMemories` IPC
call, and the `REVIEW_TIMEOUT_MS` backstop are all reused as-is.

**Tech Stack:** Preact (hooks), TypeScript, esbuild-bundled renderer. No test harness
exists for renderer components in this repo — verification here is manual (`pnpm dev`),
matching how the original review card was verified.

## Global Constraints

- Empty transcript on close → `allowChatClose()` immediately, no card shown at all (spec:
  `2026-07-03-bean-memory-design.md`, "Confirm-at-close flow").
- No cancel button during the `loading` stage — the existing 20s `REVIEW_TIMEOUT_MS` is the
  only backstop (per design decision).
- Copy: confirm-stage title is *"Before I go — want me to look for things to remember?"*;
  loading-stage text is *"Thinking about what to remember…"*; review-stage title stays
  *"Before I go — remember these?"* (unchanged).
- Gate: `pnpm build && pnpm typecheck` must exit 0 before commit.

---

### Task 1: Confirm → loading → review close flow

**Files:**
- Modify: `packages/app/src/renderer/components/chat/ChatWindow.tsx`
- Modify: `packages/app/src/renderer/shared.css`
- Verify: manual (renderer is not unit-tested in this repo)

**Interfaces:**
- Consumes: `window.bean.extractMemories`, `window.bean.listMemories`,
  `window.bean.saveMemories`, `window.bean.onReviewBeforeClose`,
  `window.bean.allowChatClose` (all pre-existing, unchanged signatures); `MemoryCandidate`,
  `Memory`, `ChatTurn` from `@bean/core`.
- Produces: no new exports — this is a self-contained rework of `ChatWindow`'s internal
  close-flow state and render branches.

- [ ] **Step 1: Replace the `review` state with a 3-stage `closeFlow` state**

In `packages/app/src/renderer/components/chat/ChatWindow.tsx`, the current top of the file
(lines 1-13) is:

```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import { ChatPanel } from "./ChatPanel.js";
import { newId, type ChatItem } from "../../shared/chat-types.js";
import type { ChatTurn, MemoryCandidate, Memory, RouteSuggestion } from "@bean/core";

// Extraction is a real LLM call — a reasoning model (e.g. gpt-5-mini) routinely takes ~5s and
// longer for bigger transcripts. This is only a backstop against a genuinely hung request, so it
// must comfortably exceed real latency; a too-short value silently discards valid memories (the
// promise loses the race and resolves to []), which is exactly the bug this replaced.
const REVIEW_TIMEOUT_MS = 20000;
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}
```

Replace it with (adds the `CloseFlow` type after the existing timeout helper):

```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import { ChatPanel } from "./ChatPanel.js";
import { newId, type ChatItem } from "../../shared/chat-types.js";
import type { ChatTurn, MemoryCandidate, Memory, RouteSuggestion } from "@bean/core";

// Extraction is a real LLM call — a reasoning model (e.g. gpt-5-mini) routinely takes ~5s and
// longer for bigger transcripts. This is only a backstop against a genuinely hung request, so it
// must comfortably exceed real latency; a too-short value silently discards valid memories (the
// promise loses the race and resolves to []), which is exactly the bug this replaced.
const REVIEW_TIMEOUT_MS = 20000;
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// Drives the "before I go" card shown when the chat window closes with a non-empty
// transcript: ask first (no LLM call yet, so the wait that follows is expected rather than
// a silent hang) → loading (extraction in flight) → review (pick which candidates to keep).
// `null` means no card — the window closes normally.
type CloseFlow =
  | { stage: "confirm" }
  | { stage: "loading" }
  | { stage: "review"; items: { text: string; projectPath?: string; checked: boolean }[] };
```

- [ ] **Step 2: Swap the `review` useState for `closeFlow` + a transcript ref**

The current state block (inside `export function ChatWindow() {`) is:

```tsx
  const [review, setReview] = useState<{ text: string; projectPath?: string; checked: boolean }[] | null>(null);
  const itemsRef = useRef<ChatItem[]>([]);
  itemsRef.current = items;
```

Replace with:

```tsx
  const [closeFlow, setCloseFlow] = useState<CloseFlow | null>(null);
  const itemsRef = useRef<ChatItem[]>([]);
  itemsRef.current = items;
  // Captured once when the confirm card appears; `confirmExtract` reads it later, after the
  // user has clicked "Extract" — a ref (not state) so the click handler always sees the
  // transcript as of close time, not whatever `items` has become since.
  const closeTranscriptRef = useRef<ChatTurn[]>([]);
```

- [ ] **Step 3: Update the close-review effect to stop at `confirm`, not extract immediately**

The current handler inside the `useEffect` is:

```tsx
    window.bean.onReviewBeforeClose(() => {
      const transcript: ChatTurn[] = itemsRef.current
        .filter((it): it is Extract<ChatItem, { kind: "user" | "reply" }> => it.kind === "user" || it.kind === "reply")
        .map((it) => ({ role: it.kind === "user" ? "user" : "assistant", content: it.text }));
      if (transcript.length === 0) { window.bean.allowChatClose(); return; }
      void withTimeout(window.bean.extractMemories(transcript), REVIEW_TIMEOUT_MS, [] as MemoryCandidate[])
        .then((candidates) => {
          if (candidates.length === 0) { window.bean.allowChatClose(); return; }
          setReview(candidates.map((c) => ({ text: c.text, projectPath: c.projectPath, checked: true })));
        })
        .catch(() => window.bean.allowChatClose());
    });
```

Replace with:

```tsx
    window.bean.onReviewBeforeClose(() => {
      const transcript: ChatTurn[] = itemsRef.current
        .filter((it): it is Extract<ChatItem, { kind: "user" | "reply" }> => it.kind === "user" || it.kind === "reply")
        .map((it) => ({ role: it.kind === "user" ? "user" : "assistant", content: it.text }));
      if (transcript.length === 0) { window.bean.allowChatClose(); return; }
      closeTranscriptRef.current = transcript;
      setCloseFlow({ stage: "confirm" });
    });
```

- [ ] **Step 4: Replace the close-flow action functions**

The current actions block is:

```tsx
  const rememberSelected = async (): Promise<void> => {
    const picked = (review ?? []).filter((r) => r.checked);
    if (picked.length > 0) {
      const existing = await window.bean.listMemories();
      const now = new Date().toISOString();
      const additions: Memory[] = picked.map((r, i) => ({
        id: `${Date.now()}-${i}`,
        text: r.text,
        projectPath: r.projectPath,
        createdAt: now,
      }));
      await window.bean.saveMemories([...existing, ...additions]);
    }
    setReview(null);
    window.bean.allowChatClose();
  };
  const skipReview = (): void => { setReview(null); window.bean.allowChatClose(); };
  const toggleReview = (idx: number): void =>
    setReview((prev) => prev?.map((r, i) => (i === idx ? { ...r, checked: !r.checked } : r)) ?? null);
```

Replace with:

```tsx
  // Shared by the confirm-stage "Skip" and the review-stage "Skip" — both mean "close with
  // no write", they just fire from different stages of the same flow.
  const dismissClose = (): void => { setCloseFlow(null); window.bean.allowChatClose(); };

  const confirmExtract = (): void => {
    setCloseFlow({ stage: "loading" });
    void withTimeout(window.bean.extractMemories(closeTranscriptRef.current), REVIEW_TIMEOUT_MS, [] as MemoryCandidate[])
      .then((candidates) => {
        if (candidates.length === 0) { dismissClose(); return; }
        setCloseFlow({
          stage: "review",
          items: candidates.map((c) => ({ text: c.text, projectPath: c.projectPath, checked: true })),
        });
      })
      .catch(dismissClose);
  };

  const rememberSelected = async (): Promise<void> => {
    const picked = (closeFlow?.stage === "review" ? closeFlow.items : []).filter((r) => r.checked);
    if (picked.length > 0) {
      const existing = await window.bean.listMemories();
      const now = new Date().toISOString();
      const additions: Memory[] = picked.map((r, i) => ({
        id: `${Date.now()}-${i}`,
        text: r.text,
        projectPath: r.projectPath,
        createdAt: now,
      }));
      await window.bean.saveMemories([...existing, ...additions]);
    }
    setCloseFlow(null);
    window.bean.allowChatClose();
  };
  const toggleReview = (idx: number): void =>
    setCloseFlow((prev) =>
      prev?.stage === "review"
        ? { ...prev, items: prev.items.map((r, i) => (i === idx ? { ...r, checked: !r.checked } : r)) }
        : prev,
    );
```

- [ ] **Step 5: Replace the render block's card with the 3-stage version**

The current render (inside the returned JSX, before `<ChatPanel .../>`) is:

```tsx
      {review ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">Before I go — remember these?</div>
            {review.map((r, i) => (
              <label key={i} class="bean-memory-review-row">
                <input type="checkbox" checked={r.checked} onChange={() => toggleReview(i)} />
                <span>{r.text}{r.projectPath ? <em class="bean-memory-review-tag"> · project</em> : null}</span>
              </label>
            ))}
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => void rememberSelected()}>Remember</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={skipReview}>Skip</button>
            </div>
          </div>
        </div>
      ) : null}
```

Replace with:

```tsx
      {closeFlow?.stage === "confirm" ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">Before I go — want me to look for things to remember?</div>
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={confirmExtract}>Extract</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={dismissClose}>Skip</button>
            </div>
          </div>
        </div>
      ) : null}
      {closeFlow?.stage === "loading" ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-loading">Thinking about what to remember…</div>
          </div>
        </div>
      ) : null}
      {closeFlow?.stage === "review" ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">Before I go — remember these?</div>
            {closeFlow.items.map((r, i) => (
              <label key={i} class="bean-memory-review-row">
                <input type="checkbox" checked={r.checked} onChange={() => toggleReview(i)} />
                <span>{r.text}{r.projectPath ? <em class="bean-memory-review-tag"> · project</em> : null}</span>
              </label>
            ))}
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={() => void rememberSelected()}>Remember</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={dismissClose}>Skip</button>
            </div>
          </div>
        </div>
      ) : null}
```

- [ ] **Step 6: Add the loading-state style**

In `packages/app/src/renderer/shared.css`, find the existing memory-review rules:

```css
.bean-memory-review-tag { opacity: 0.6; font-style: normal; }
```

Add immediately after it:

```css
.bean-memory-review-loading { font-size: 13px; font-style: italic; opacity: 0.7; }
```

- [ ] **Step 7: Build and typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: exit 0. This catches any leftover reference to the old `review`/`skipReview`
names (there should be none — `grep -n "setReview\|skipReview" packages/app/src/renderer/components/chat/ChatWindow.tsx`
should return nothing).

- [ ] **Step 8: Manual verification**

Run: `pnpm dev`. Then:
1. Double-click the avatar → chat → say something substantive, e.g. "I always use pnpm and
   prefer terse commit messages." Wait for Bean's reply.
2. Click the chat window's close button. Expected: card reads *"Before I go — want me to
   look for things to remember?"* with **Extract** / **Skip** buttons — window does not
   hang or start extracting yet.
3. Click **Skip**. Expected: window closes immediately. Confirm `~/.bean/memory.json` was
   **not** modified (no extraction ever ran).
4. Reopen chat, repeat the same message, close, this time click **Extract**. Expected: card
   immediately switches to *"Thinking about what to remember…"* (no buttons), then after a
   few seconds switches to the checkbox review card with at least one candidate checked.
5. Click **Remember**. Expected: window closes; `~/.bean/memory.json` now contains the
   fact(s).
6. Reopen chat, ask "what do you know about how I work?" Expected: Bean references the
   remembered preference (recall path untouched by this change).
7. Open chat, send nothing, close it. Expected: closes immediately with no card at all
   (empty-transcript short-circuit, unchanged).

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/renderer/components/chat/ChatWindow.tsx packages/app/src/renderer/shared.css
git commit -m "feat(app): confirm before extracting memories on chat close"
```
