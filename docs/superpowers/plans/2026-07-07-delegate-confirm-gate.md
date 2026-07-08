# Delegate Confirm Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `DelegateCard` "Delegate" button the real, sole gate before a background delegate task runs, and stop the model from asking permission in chat text before proposing one.

**Architecture:** Two independent, small fixes. (1) In `packages/core/src/converse.ts`, reword the `propose_delegate` prompt guidance so the model calls the tool directly instead of asking "want me to do this?" in chat text first. (2) In `packages/app/src/renderer/components/chat/ChatWindow.tsx`, fix a real bug: new delegate proposals are currently created in `state: "starting"` and auto-started via `queueMicrotask` in the same turn `converse()` returns a `proposedDelegate` — the `DelegateCard`'s button (`disabled={!pending}`) can therefore never be clicked. Fix: create proposals in `state: "pending"` and delete the auto-start call, matching how `proposedRun`/`proposedNote` items already behave.

**Tech Stack:** TypeScript, Vitest, Preact (renderer). No new dependencies.

## Global Constraints

- Follow `pnpm test && pnpm typecheck` as the validation gate (per `AGENTS.md`) — both must exit 0 before this is done.
- `packages/core` stays pure/dependency-injected and Electron-free (no changes to that boundary here — this plan only edits prompt strings in `converse.ts`).
- Files use `.js` extensions in relative imports (ESM + `verbatimModuleSyntax`) — already the case in the files touched; no new imports needed.
- Scope is `propose_delegate` only. Do not touch `propose_run` / `ProposalCard` behavior or wording.

---

### Task 1: Stop the model asking permission in chat text before delegating

**Files:**
- Modify: `packages/core/src/converse.ts:38-57` (`BEHAVIOR_INSTRUCTIONS`), `packages/core/src/converse.ts:126-134` (`proposeDelegateTool`)
- Test: `packages/core/__test__/converse.test.ts`

**Interfaces:**
- Consumes: nothing new — `BEHAVIOR_INSTRUCTIONS` is a module-level `const string`; `proposeDelegateTool(skills, projects)` returns `ToolSpec` with a `description: string` field (unchanged signature).
- Produces: nothing new — no exported types or function signatures change. Later tasks don't depend on this task's output.

- [ ] **Step 1: Write the failing tests**

Add this test to `packages/core/__test__/converse.test.ts`, directly after the existing `"delegate instructions tell the model to inspect linked projects instead of refusing"` test (currently ending at line 141):

```ts
test("delegate guidance tells the model to propose directly, not ask permission in chat first", async () => {
  let systemContent = "";
  let delegateDescription = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages, tools }) => {
      systemContent = messages[0]!.content;
      delegateDescription = tools.find((t) => t.name === "propose_delegate")?.description ?? "";
      return { content: "ok", toolCalls: [] };
    },
  };

  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true);

  expect(systemContent).toContain("don't ask the user in chat text whether you should delegate first");
  expect(delegateDescription).toContain("don't ask the user for permission in chat text first");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts -t "propose directly"`
Expected: FAIL — neither substring exists yet in `systemContent` or `delegateDescription`.

- [ ] **Step 3: Reword the prompt guidance**

In `packages/core/src/converse.ts`, replace the `BEHAVIOR_INSTRUCTIONS` constant (lines 38-57) with:

```ts
const BEHAVIOR_INSTRUCTIONS =
  "You cannot do project work yourself — a separate `opencode` process does. When the user " +
  "wants a concrete task done in one of their projects, call the propose_run tool with the " +
  "best matching skill name, project path, and a clear instruction; otherwise just reply in " +
  "text. Any other tools you are given (reminders etc.) you DO execute yourself — call them " +
  "directly when the user asks, then confirm what you did in one short sentence. " +
  "Only propose a run when the user clearly wants work done. The skills/projects list below " +
  "is for your own routing decisions — don't recite or summarize it unprompted. Only describe " +
  "your skills or projects if the user directly asks what you can do. " +
  "When the user asks to save this talk as a note, or a substantive discussion winds down " +
  "with unresolved threads, call propose_note to draft one — the user confirms it before " +
  "anything is saved. Notes capture conversation output (summaries, ideas, open questions), " +
  "NOT durable one-line facts about the user — those are handled elsewhere. Don't propose a " +
  "note for small talk or a talk that reached no substance. If you are given a " +
  "propose_delegate tool: use it when the user wants project work done; a background " +
  "agent does the work while the chat stays open, and its result returns to this " +
  "conversation. Call propose_delegate directly — don't ask the user in chat text whether " +
  "you should delegate first; the card Bean shows afterward is the confirmation step. " +
  "If the user asks you to inspect, explore, summarize, or explain a linked project, " +
  "use propose_delegate; do not say you cannot access the repository. " +
  "Use propose_run instead when the user wants to watch or continue the " +
  "work in their own terminal. Both are confirm-first via the card shown after you " +
  "propose — not by asking permission in chat text.";
```

Then replace the `description` field inside `proposeDelegateTool` (lines 126-134) with:

```ts
function proposeDelegateTool(skills: Skill[], projects: Project[]): ToolSpec {
  const properties: Record<string, unknown> = {
    project: { type: "string", enum: projects.map((p) => p.path), description: "the project path to work in" },
    instruction: {
      type: "string",
      description: "the concrete, self-contained task for the delegated agent — include all context it needs",
    },
  };
  if (skills.length > 0) {
    properties.skill = {
      type: "string",
      enum: skills.map((s) => s.name),
      description: "optional skill whose instructions frame the task; omit for a free-form task",
    };
  }
  return {
    name: "propose_delegate",
    description:
      "Delegate a task to a background coding agent that can inspect, summarize, explain, or work " +
      "inside the project and reports the result back to this chat when finished. Call it directly — " +
      "don't ask the user for permission in chat text first; the card shown afterward is what the " +
      "user confirms and edits before it actually starts.",
    parameters: { type: "object", properties, required: ["project", "instruction"] },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: PASS — all tests in the file, including the new one and the pre-existing `"delegate guidance lives in behavior instructions"` and `"delegate instructions tell the model to inspect linked projects instead of refusing"` tests (their asserted substrings — `"a background agent does the work while the chat stays open"`, `"its result returns to this conversation"`, `"inspect, explore, summarize, or explain a linked project"`, `"do not say you cannot access the repository"`, `"inspect, summarize, explain"` — are preserved verbatim in the reworded text above).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/converse.ts packages/core/__test__/converse.test.ts
git commit -m "core: stop model asking permission in chat before propose_delegate"
```

---

### Task 2: Fix the delegate auto-start bug — require a button click

**Files:**
- Modify: `packages/app/src/renderer/components/chat/ChatWindow.tsx:36-38` (`addDelegateProposal`), `packages/app/src/renderer/components/chat/ChatWindow.tsx:186-199` (`sendMessage`)
- Test: `packages/app/__test__/chat-window-delegate.test.ts:16-25`

**Interfaces:**
- Consumes: `ChatItem` type from `../../shared/chat-types.js` (unchanged), `ProposedDelegate` type from `@bean/core` (unchanged).
- Produces: `addDelegateProposal(items: ChatItem[], proposal: ProposedDelegate, id: string): ChatItem[]` — same exported signature, now returns an item with `state: "pending"` instead of `"starting"`. No other task depends on this task's output.

- [ ] **Step 1: Update the failing test**

Replace the first test in the `"ChatWindow delegate state"` describe block in `packages/app/__test__/chat-window-delegate.test.ts` (currently lines 16-25):

```ts
  it("adds delegate proposals in pending state, awaiting user confirmation", () => {
    const result = addDelegateProposal([], {
      projectPath: "/p",
      instruction: "read README",
      composedPrompt: "read README",
    }, "d1");

    expect(result[0]).toMatchObject({ kind: "delegate", id: "d1", state: "pending" });
    expect(result[0]).not.toHaveProperty("taskId");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/chat-window-delegate.test.ts -t "pending state"`
Expected: FAIL — `addDelegateProposal` still returns `state: "starting"`.

- [ ] **Step 3: Fix `addDelegateProposal` and remove the auto-start call**

In `packages/app/src/renderer/components/chat/ChatWindow.tsx`, change line 37 from:

```ts
  return [...items, { kind: "delegate", id, proposal, state: "starting", tail: [] }];
```

to:

```ts
  return [...items, { kind: "delegate", id, proposal, state: "pending", tail: [] }];
```

Then, in `sendMessage`, replace the `setItems` callback (lines 186-199):

```ts
      setItems((prev) => {
        const next = prev.filter((it) => it.id !== workingId);
        let delegateToStart: { id: string; projectPath: string; prompt: string } | undefined;
        if (res.reply.trim()) next.push({ kind: "reply", id: newId(), text: res.reply });
        if (res.proposedRun) next.push({ kind: "proposal", id: newId(), run: res.proposedRun, state: "pending" });
        if (res.proposedNote) next.push({ kind: "note", id: newId(), note: res.proposedNote, state: "pending" });
        if (res.proposedDelegate) {
          const id = newId();
          delegateToStart = { id, projectPath: res.proposedDelegate.projectPath, prompt: res.proposedDelegate.composedPrompt };
          next.push(...addDelegateProposal([], res.proposedDelegate, id));
        }
        if (delegateToStart) queueMicrotask(() => void startDelegate(delegateToStart.id, delegateToStart.projectPath, delegateToStart.prompt));
        return next;
      });
```

with:

```ts
      setItems((prev) => {
        const next = prev.filter((it) => it.id !== workingId);
        if (res.reply.trim()) next.push({ kind: "reply", id: newId(), text: res.reply });
        if (res.proposedRun) next.push({ kind: "proposal", id: newId(), run: res.proposedRun, state: "pending" });
        if (res.proposedNote) next.push({ kind: "note", id: newId(), note: res.proposedNote, state: "pending" });
        if (res.proposedDelegate) next.push(...addDelegateProposal([], res.proposedDelegate, newId()));
        return next;
      });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bean/app exec vitest run __test__/chat-window-delegate.test.ts`
Expected: PASS — all tests in the file, including the other pre-existing delegate-state tests (`"marks a pending delegate as starting before taskId is known"`, `"treats starting delegates as active during close"`), which are unaffected since they exercise `markDelegateStarting`/`hasActiveDelegates` directly with hand-built items, not `addDelegateProposal`.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @bean/app typecheck`
Expected: exits 0 — `delegateToStart` and its `queueMicrotask` block are fully removed, so no unused-variable or dangling-reference errors.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/renderer/components/chat/ChatWindow.tsx packages/app/__test__/chat-window-delegate.test.ts
git commit -m "app: require a button click before a delegate task starts"
```

---

### Task 3: Full validation and manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0 across every package.

- [ ] **Step 2: Manual smoke test in the running app**

Run: `pnpm dev`

In the chat window, ask Bean to delegate a task in a linked project (e.g. "delegate a task to summarize this project" or similar, in a chat where a project with `propose_delegate` available is linked). Confirm:
- The assistant's reply does **not** ask a conversational "want me to delegate this?" question — it proposes directly.
- A `DelegateCard` appears with `state: "pending"`: the prompt textarea is editable, and the "Delegate" button is enabled (not showing "Starting..." or a running timer).
- The background agent does **not** start until you click "Delegate".
- After clicking, the button becomes disabled and shows "Starting..." then "Working... mm:ss", matching pre-existing `DelegateCard` behavior.

- [ ] **Step 3: Report result**

If any manual check fails, stop and re-open the relevant task above rather than proceeding — do not report success without having actually driven this flow in the running app.
