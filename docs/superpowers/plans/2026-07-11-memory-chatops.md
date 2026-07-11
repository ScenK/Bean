# Memory capture in Teams/Discord — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Teams and Discord bots capture durable memories via a confirm-first, per-item-selectable card — the memory counterpart to the #27 notes flow.

**Architecture:** A gated, argless `propose_remember` tool in `converse()` is the trigger (model decides *when*, on explicit user ask only); the existing `extractMemories()` decides *what*. Candidates are held in a new `MemoryProposalStore`, rendered as a selectable card, and persisted with `saveMemories()`. Each platform normalizes its native selection into a neutral `memoryPicks` list (undefined = all).

**Tech Stack:** TypeScript (ESM, strict, `noUncheckedIndexedAccess`), vitest, pnpm workspace. `@bean/core` (tsc), `@bean/teams` (botbuilder AdaptiveCards), `@bean/discord` (discord.js raw component JSON).

## Global Constraints

- ESM with `verbatimModuleSyntax`: use `.js` extensions in relative imports; `import type` for type-only imports.
- `strict` + `noUncheckedIndexedAccess`: array access is `T | undefined` — handle it.
- Files kebab-case; async exports have explicit `Promise<T>` return types.
- Import from `@bean/core` (barrel), not deep paths, in `@bean/teams` / `@bean/discord`.
- Validation gate: `pnpm test && pnpm typecheck` exit 0. Run per-package with `pnpm --filter <pkg> exec vitest run <file>`.
- `saveMemories(file, memories)` writes the **full** array — always `[...existing, ...additions]`.
- `memoryPicks === undefined` means "all candidates selected"; an empty array means "none".
- Work happens in the `.worktrees/memory-chatops` worktree (branch `memory-chatops`).

---

### Task 1: `MemoryProposalStore` (core)

**Files:**
- Create: `packages/core/src/chatops/memory-proposals.ts`
- Create: `packages/core/__test__/chatops-memory-proposals.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `MemoryCandidate` from `../memory/memory.js`.
- Produces:
  - `interface PendingMemory { id: string; candidates: MemoryCandidate[]; conversationId: string; proposedBy: string; cardActivityId?: string; createdAt: number; }`
  - `class MemoryProposalStore` with `constructor(nowMs?: () => number)`, `add(p: Omit<PendingMemory, "id" | "createdAt">): PendingMemory` (assigns `mem-<n>` ids), `setCardActivityId(id: string, activityId: string): void`, `claim(id: string): PendingMemory | undefined` (one-shot, 10-min expiry).

- [ ] **Step 1: Write the failing test**

Create `packages/core/__test__/chatops-memory-proposals.test.ts`:

```typescript
import { expect, test } from "vitest";
import { MemoryProposalStore } from "../src/chatops/memory-proposals.js";

const candidates = [{ text: "uses tabs" }, { text: "prefers vitest", projectPath: "/dev/bean" }];
const base = { candidates, conversationId: "c1", proposedBy: "alice" };

test("add assigns unique mem-* ids and claim is one-shot", () => {
  const s = new MemoryProposalStore(() => 0);
  const a = s.add(base);
  const b = s.add(base);
  expect(a.id).toMatch(/^mem-\d+$/);
  expect(a.id).not.toBe(b.id);
  expect(s.claim(a.id)?.proposedBy).toBe("alice");
  expect(s.claim(a.id)).toBeUndefined(); // already claimed
});

test("claim returns undefined after the 10-minute expiry", () => {
  let now = 0;
  const s = new MemoryProposalStore(() => now);
  const p = s.add(base);
  now = 10 * 60_000 + 1;
  expect(s.claim(p.id)).toBeUndefined();
});

test("setCardActivityId records the card message id for later edits", () => {
  const s = new MemoryProposalStore(() => 0);
  const p = s.add(base);
  s.setCardActivityId(p.id, "act-9");
  expect(s.claim(p.id)?.cardActivityId).toBe("act-9");
});

test("claim of an unknown id returns undefined", () => {
  expect(new MemoryProposalStore().claim("nope")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-memory-proposals.test.ts`
Expected: FAIL — cannot resolve `../src/chatops/memory-proposals.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/chatops/memory-proposals.ts`:

```typescript
import type { MemoryCandidate } from "../memory/memory.js";

/** A pending confirm-first batch of extracted memory candidates awaiting a
 * Remember/Cancel tap on its card. */
export interface PendingMemory {
  id: string;
  candidates: MemoryCandidate[];
  conversationId: string;
  proposedBy: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending confirm-first memory proposals — the memory counterpart to NoteProposalStore.
 * claim() is one-shot so two members tapping Remember on the same card can't double-save. */
export class MemoryProposalStore {
  private byId = new Map<string, PendingMemory>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingMemory, "id" | "createdAt">): PendingMemory {
    const full: PendingMemory = { ...p, id: `mem-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  claim(id: string): PendingMemory | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
```

Add to `packages/core/src/index.ts` after the `note-proposals.js` export line:

```typescript
export * from "./chatops/memory-proposals.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-memory-proposals.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chatops/memory-proposals.ts packages/core/__test__/chatops-memory-proposals.test.ts packages/core/src/index.ts
git commit -m "Add MemoryProposalStore for confirm-first memory batches"
```

---

### Task 2: `propose_remember` tool in `converse()` (core)

**Files:**
- Modify: `packages/core/src/converse.ts`
- Modify: `packages/core/__test__/converse.test.ts`

**Interfaces:**
- Consumes: existing `converse()` and its tool-loop.
- Produces:
  - `ConverseResult` gains `proposedRemember?: boolean`.
  - `converse(...)` gains a trailing parameter `rememberAvailable = false` (position 14, after `availableClis`).
  - When `rememberAvailable` is true, a `propose_remember` tool (argless) is offered; a call returns `{ reply, model, proposedRemember: true }`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/__test__/converse.test.ts` (uses the file's existing `skills`, `projects`, `depsReturning`, `DEFAULT_PERSONA`):

```typescript
test("propose_remember tool is only offered when rememberAvailable is true", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "ok", toolCalls: [] }; },
  };
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps,
    undefined, [], undefined, undefined, false, [], true);
  expect(captured.map((t) => t.name)).toContain("propose_remember");
  const remember = captured.find((t) => t.name === "propose_remember")!;
  expect((remember.parameters as { properties: object }).properties).toEqual({});
});

test("propose_remember is absent by default (desktop path)", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "ok", toolCalls: [] }; },
  };
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(captured.map((t) => t.name)).not.toContain("propose_remember");
});

test("a propose_remember tool call short-circuits to proposedRemember", async () => {
  const deps = depsReturning("Sure — which of these should I keep?", [
    { name: "propose_remember", args: {} },
  ]);
  const res = await converse([], "remember what we discussed", skills, projects, DEFAULT_PERSONA, [], deps,
    undefined, [], undefined, undefined, false, [], true);
  expect(res.reply).toBe("Sure — which of these should I keep?");
  expect(res.proposedRemember).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts -t "propose_remember"`
Expected: FAIL — tool not offered / `proposedRemember` undefined.

- [ ] **Step 3: Implement the tool, gating, and short-circuit**

In `packages/core/src/converse.ts`:

3a. Extend `ConverseResult` (the `interface ConverseResult` line) to add the field:

```typescript
export interface ConverseResult { reply: string; model?: string; proposedRun?: ProposedRun; proposedNote?: ProposedNote; proposedDelegate?: ProposedDelegate; proposedRemember?: boolean; }
```

3b. Add the tool builder near `proposeNoteTool` (after it):

```typescript
// Argless: a trigger only. The model decides WHEN to offer to remember; extractMemories()
// (run by the caller) decides WHAT. Gated behind rememberAvailable so the desktop app —
// which captures memory at chat-close — never grows a second memory path.
function proposeRememberTool(): ToolSpec {
  return {
    name: "propose_remember",
    description:
      "Call this only when the user explicitly asks you to remember or save durable facts from " +
      "this conversation (e.g. \"remember this\", \"save what we figured out\"). It offers the user " +
      "a card of candidate facts to confirm — do not use it to save anything silently, and do not " +
      "call it proactively without an explicit ask.",
    parameters: { type: "object", properties: {} },
  };
}
```

3c. Add the parameter to the `converse` signature — append after `availableClis`:

```typescript
  delegateAvailable = false,
  availableClis: CliName[] = [],
  rememberAvailable = false,
): Promise<ConverseResult> {
```

3d. Add the tool to the `tools` array (after the `proposeNoteTool(projects, linkedNote)` entry):

```typescript
  const tools = [
    ...(skills.length > 0 ? [proposeRunTool(skills, projects)] : []),
    ...(delegateAvailable && projects.length > 0 ? [proposeDelegateTool(skills, projects, availableClis)] : []),
    proposeNoteTool(projects, linkedNote),
    ...(rememberAvailable ? [proposeRememberTool()] : []),
    ...actions.map((a) => a.spec),
  ];
```

3e. Add the short-circuit in the tool-loop, immediately after the `noteCall` block (before the `actionCalls` handling):

```typescript
    const rememberCall = toolCalls.find((c) => c.name === "propose_remember");
    if (rememberCall) {
      return { reply: content, model: deps.model, proposedRemember: true };
    }
```

3f. In `BEHAVIOR_INSTRUCTIONS`, append this sentence to the final string segment (after the delegate guidance):

```
  " When the user explicitly asks you to remember or save durable facts from this chat, call " +
  "propose_remember — the user then confirms which facts are kept; never save memory silently.";
```

(Move the closing `;` to the new final segment.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: PASS (all, including the 3 new ones and the unchanged existing suite — the default-off gate keeps `["propose_run", "propose_note"]` assertions green).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/converse.ts packages/core/__test__/converse.test.ts
git commit -m "Add gated propose_remember tool to converse"
```

---

### Task 3: Card types + bot wiring (core)

**Files:**
- Modify: `packages/core/src/chatops/cards-api.ts`
- Modify: `packages/core/src/chatops/bot.ts`
- Modify: `packages/core/__test__/chatops-bot.test.ts`

**Interfaces:**
- Consumes: `MemoryProposalStore`/`PendingMemory` (Task 1); `proposedRemember` (Task 2); `extractMemories`, `Memory`, `MemoryCandidate` from core.
- Produces:
  - `cards-api.ts`: `MemoryProposalCardInput { proposalId: string; facts: { text: string; projectName?: string }[] }`, `MemoryResultCardInput { count: number; savedBy: string; outcome: "saved" | "cancelled" }`; `CardBuilders` gains `memoryProposalCard(input: MemoryProposalCardInput): object` and `memoryResultCard(input: MemoryResultCardInput): object`.
  - `TeamsBotDeps` gains `memoryProposals: MemoryProposalStore` and `saveMemories: (memories: Memory[]) => Promise<void>`.
  - `CardAction["value"]` gains `memoryPicks?: string[]`.

- [ ] **Step 1: Add the card-api types**

In `packages/core/src/chatops/cards-api.ts`, after the `NoteResultCardInput` interface:

```typescript
export interface MemoryProposalCardInput {
  proposalId: string;
  /** Candidate facts to confirm; projectName is the resolved display name or absent for global. */
  facts: { text: string; projectName?: string }[];
}

export interface MemoryResultCardInput {
  count: number;
  savedBy: string;
  outcome: "saved" | "cancelled";
}
```

And extend the `CardBuilders` interface (add the two lines before its closing brace):

```typescript
  memoryProposalCard: (input: MemoryProposalCardInput) => object;
  memoryResultCard: (input: MemoryResultCardInput) => object;
```

- [ ] **Step 2: Write the failing bot tests**

In `packages/core/__test__/chatops-bot.test.ts`:

2a. Add to the `fakeCards` object (after the `noteResultCard` line):

```typescript
  memoryProposalCard: (i: object) => ({ kind: "memory-proposal", ...i }),
  memoryResultCard: (i: object) => ({ kind: "memory-result", ...i }),
```

2b. Add memory deps to `makeDeps`. After the `savedNotes` array declaration add:

```typescript
  const savedMemories: import("../src/memory/memory.js").Memory[][] = [];
```

In the `deps` object (after the `saveNote` line) add:

```typescript
    memoryProposals: new MemoryProposalStore(),
    saveMemories: async (mems) => { savedMemories.push(mems); },
```

Update the return: `return { deps, delegateCalls, saved, savedNotes, savedMemories };`

Add the import at the top (with the other store imports):

```typescript
import { MemoryProposalStore } from "../src/chatops/memory-proposals.js";
```

2c. Add the tests (after the note tests). `rememberChat` makes `converse()` short-circuit to `proposedRemember`; the SAME fake `chat` is then reused by `extractMemories`, so it must also answer the extract pass with `remember` tool calls. We give it a call-count switch:

```typescript
// First call (converse) → propose_remember; second call (extractMemories) → two facts.
function rememberDeps() {
  let call = 0;
  const chat: TeamsBotDeps["chat"] = async () => {
    call++;
    if (call === 1) return { content: "Which should I keep?", toolCalls: [{ name: "propose_remember", args: {} }] };
    return {
      content: "",
      toolCalls: [
        { name: "remember", args: { text: "prefers tabs" } },
        { name: "remember", args: { text: "uses vitest", projectPath: "/dev/bean" } },
      ],
    };
  };
  return makeDeps({ chat });
}

async function proposeMemoryThenId(deps: TeamsBotDeps, effects: ReturnType<typeof fx>): Promise<string> {
  await buildTeamsBot(deps).onMessage(msg, effects);
  const card = JSON.stringify(effects.cards[0]);
  const match = /"proposalId":"(mem-\d+)"/.exec(card);
  if (!match?.[1]) throw new Error("no memory proposal id in card");
  return match[1];
}

test("proposedRemember runs extraction and posts a selectable memory card", async () => {
  const { deps } = rememberDeps();
  const effects = fx();
  await buildTeamsBot(deps).onMessage(msg, effects);
  expect(effects.cards).toHaveLength(1);
  const s = JSON.stringify(effects.cards[0]);
  expect(s).toContain("memory-proposal");
  expect(s).toContain("prefers tabs");
  expect(s).toContain("uses vitest");
});

test("save-memories with undefined memoryPicks saves every candidate", async () => {
  const { deps, savedMemories } = rememberDeps();
  const effects = fx();
  const id = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: id } },
    effects,
  );
  expect(savedMemories).toHaveLength(1);
  expect(savedMemories[0]).toHaveLength(2);
  expect(savedMemories[0]!.map((m) => m.text)).toEqual(["prefers tabs", "uses vitest"]);
  expect(savedMemories[0]![1]!.projectPath).toBe("/dev/bean");
  expect(effects.posted.some((p) => p.includes("Remembered 2"))).toBe(true);
});

test("save-memories honors memoryPicks and saves only the selected subset", async () => {
  const { deps, savedMemories } = rememberDeps();
  const effects = fx();
  const id = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: id, memoryPicks: ["1"] } },
    effects,
  );
  expect(savedMemories[0]).toHaveLength(1);
  expect(savedMemories[0]![0]!.text).toBe("uses vitest");
});

test("save-memories with an empty pick set saves nothing", async () => {
  const { deps, savedMemories } = rememberDeps();
  const effects = fx();
  const id = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: id, memoryPicks: [] } },
    effects,
  );
  expect(savedMemories).toHaveLength(0);
});

test("cancel-memories updates the card and saves nothing", async () => {
  const { deps, savedMemories } = rememberDeps();
  const effects = fx();
  const id = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "cancel-memories", proposalId: id } },
    effects,
  );
  expect(savedMemories).toHaveLength(0);
  expect(JSON.stringify(effects.updates.at(-1)?.card)).toContain("cancelled");
});

test("save-memories on an expired proposal posts a message and saves nothing", async () => {
  const { deps, savedMemories } = rememberDeps();
  const effects = fx();
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: "mem-999" } },
    effects,
  );
  expect(savedMemories).toHaveLength(0);
  expect(effects.posted.some((p) => p.includes("expired"))).toBe(true);
});

test("proposedRemember with no extracted facts posts a message and no card", async () => {
  let call = 0;
  const chat: TeamsBotDeps["chat"] = async () => {
    call++;
    if (call === 1) return { content: "ok", toolCalls: [{ name: "propose_remember", args: {} }] };
    return { content: "", toolCalls: [] };
  };
  const { deps } = makeDeps({ chat });
  const effects = fx();
  await buildTeamsBot(deps).onMessage(msg, effects);
  expect(effects.cards).toHaveLength(0);
  expect(effects.posted.some((p) => p.toLowerCase().includes("nothing"))).toBe(true);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-bot.test.ts -t "memor"`
Expected: FAIL — deps missing / no memory handling.

- [ ] **Step 4: Implement the bot wiring**

In `packages/core/src/chatops/bot.ts`:

4a. Add imports (with the existing type imports):

```typescript
import { extractMemories } from "../memory/extract.js";
import type { Memory, MemoryCandidate } from "../memory/memory.js";
import type { MemoryProposalStore } from "./memory-proposals.js";
```

(There is already `import type { Memory } from "../memory/memory.js";` — replace it with the combined `Memory, MemoryCandidate` line above and delete the old one.)

4b. Extend `TeamsBotDeps` (after the `saveNote` field):

```typescript
  memoryProposals: MemoryProposalStore;
  /** Persists the full memory list (server injects the memory file path). */
  saveMemories: (memories: Memory[]) => Promise<void>;
```

4c. Extend `CardAction.value` type (add the field):

```typescript
  value: { beanAction?: string; proposalId?: string; projectPath?: string; cli?: string; model?: string; memoryPicks?: string[] };
```

4d. Add `handleMemoryAction` next to `handleNoteAction` (inside `buildTeamsBot`, before the `return {`):

```typescript
  async function handleMemoryAction(
    kind: "save-memories" | "cancel-memories",
    proposalId: string | undefined,
    memoryPicks: string[] | undefined,
    actor: string,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
    const pending = deps.memoryProposals.claim(proposalId);
    if (!pending) {
      await fx.post("That memory batch expired — ask me to remember again.");
      return;
    }
    const resultCard = (outcome: "saved" | "cancelled", count: number): object =>
      deps.cards.memoryResultCard({ count, savedBy: actor, outcome });
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-memories") {
      await updateTo(resultCard("cancelled", 0));
      return;
    }
    // undefined picks = the platform's "all selected" default (e.g. Discord's untouched menu).
    const selected = memoryPicks === undefined
      ? pending.candidates
      : memoryPicks.map((i) => pending.candidates[Number(i)]).filter((c): c is MemoryCandidate => c !== undefined);
    if (selected.length === 0) {
      await updateTo(resultCard("cancelled", 0));
      await fx.post("Didn't remember anything — nothing was selected.");
      return;
    }
    try {
      const existing = await deps.loadMemories();
      const now = new Date().toISOString();
      const additions: Memory[] = selected.map((c, i) => ({
        id: `${Date.now()}-${i}`, text: c.text, projectPath: c.projectPath, createdAt: now,
      }));
      await deps.saveMemories([...existing, ...additions]);
      await updateTo(resultCard("saved", selected.length));
      await fx.post(`Remembered ${selected.length} fact(s).`);
    } catch (err) {
      await fx.post(`Couldn't save memory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

4e. Pass `rememberAvailable: true` to `converse()` — the call currently ends `..., undefined, undefined, true, detected,`. Change it to:

```typescript
        const result = await converse(
          history, msg.text, skills, projects, persona, memories,
          { chat: deps.chat, model: deps.model },
          undefined, [], undefined, undefined, true, detected, true,
        );
```

4f. Add the `proposedRemember` branch in `onMessage`, immediately after the `proposedNote` branch's closing `}` (before `const proposal = result.proposedDelegate;`):

```typescript
        if (result.proposedRemember) {
          const transcript = [...history, { role: "user" as const, content: msg.text }];
          const candidates = await extractMemories(
            transcript, memories, projects, { chat: deps.chat, model: deps.model },
          );
          if (candidates.length === 0) {
            await fx.post("Nothing here worth remembering long-term.");
            return;
          }
          const nameFor = (path: string): string => projects.find((p) => p.path === path)?.name ?? path;
          const facts = candidates.map((c) => ({
            text: c.text, projectName: c.projectPath ? nameFor(c.projectPath) : undefined,
          }));
          const pending = deps.memoryProposals.add({ candidates, conversationId: msg.conversationId, proposedBy: msg.fromName });
          const activityId = await fx.postCard(deps.cards.memoryProposalCard({ proposalId: pending.id, facts }));
          deps.memoryProposals.setCardActivityId(pending.id, activityId);
          return;
        }
```

4g. Add the card-action dispatch in `onCardAction`, next to the note branch:

```typescript
      if (beanAction === "save-memories" || beanAction === "cancel-memories") {
        await handleMemoryAction(beanAction, proposalId, action.value.memoryPicks, action.fromName, fx);
        return;
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-bot.test.ts`
Expected: PASS (existing + new memory tests).

- [ ] **Step 6: Typecheck core and commit**

Run: `pnpm --filter @bean/core exec tsc --noEmit`
Expected: no errors.

```bash
git add packages/core/src/chatops/cards-api.ts packages/core/src/chatops/bot.ts packages/core/__test__/chatops-bot.test.ts
git commit -m "Wire memory proposal flow into the chatops bot"
```

---

### Task 4: Teams cards + server wiring

**Files:**
- Modify: `packages/teams/src/cards.ts`
- Modify: `packages/teams/src/server.ts`
- Modify: `packages/teams/__test__/cards.test.ts`

**Interfaces:**
- Consumes: `MemoryProposalCardInput`, `MemoryResultCardInput` from `@bean/core`; `MemoryProposalStore`, `saveMemories`, `memoryFile`.
- Produces: `memoryProposalCard(input): object` (one `Input.Toggle` per fact, id `fact-<i>`), `memoryResultCard(input): object`.

- [ ] **Step 1: Write the failing card tests**

In `packages/teams/__test__/cards.test.ts`:

1a. Extend the import:

```typescript
import {
  finishedCard, memoryProposalCard, memoryResultCard, noteProposalCard, noteResultCard, proposalCard, runningCard,
} from "../src/cards.js";
```

1b. Add tests:

```typescript
test("memory proposal card renders a toggle per fact and wires remember/cancel", () => {
  const s = flatten(memoryProposalCard({
    proposalId: "mem-1",
    facts: [{ text: "prefers tabs" }, { text: "uses vitest", projectName: "bean" }],
  }));
  expect(s).toContain("prefers tabs");
  expect(s).toContain("uses vitest");
  expect(s).toContain('"id":"fact-0"');
  expect(s).toContain('"id":"fact-1"');
  expect(s).toContain('"beanAction":"save-memories"');
  expect(s).toContain('"beanAction":"cancel-memories"');
  expect(s).toContain('"proposalId":"mem-1"');
});

test("memory result card states the count/outcome and has no actions", () => {
  const card = memoryResultCard({ count: 2, savedBy: "bob", outcome: "saved" }) as { actions?: unknown[] };
  expect(card.actions ?? []).toHaveLength(0);
  const s = flatten(card);
  expect(s).toContain("saved");
  expect(s).toContain("2");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/teams exec vitest run __test__/cards.test.ts -t "memory"`
Expected: FAIL — `memoryProposalCard` is not exported.

- [ ] **Step 3: Implement the cards**

Extend the import in `packages/teams/src/cards.ts`:

```typescript
import type {
  ProposalCardInput, RunningCardInput, FinishedCardInput, NoteProposalCardInput, NoteResultCardInput,
  MemoryProposalCardInput, MemoryResultCardInput,
} from "@bean/core";
```

Append at end of file:

```typescript
/** Confirm-first memory batch: one selectable toggle per candidate fact (default on),
 * Remember selected / Cancel. Toggle ids fact-<i> come back merged into the Submit payload;
 * the Teams server turns the "true" ones into memoryPicks. */
export function memoryProposalCard(input: MemoryProposalCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", size: "medium", weight: "bolder", text: "Bean wants to remember" },
      ...input.facts.map((f, i) => ({
        type: "Input.Toggle",
        id: `fact-${i}`,
        title: f.projectName ? `(${f.projectName}) ${f.text}` : f.text,
        value: "true",
        wrap: true,
      })),
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Remember selected",
        style: "positive",
        data: { beanAction: "save-memories", proposalId: input.proposalId },
      },
      { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-memories", proposalId: input.proposalId } },
    ],
  };
}

export function memoryResultCard(input: MemoryResultCardInput): object {
  const text = input.outcome === "saved"
    ? `Remembered ${input.count} fact(s) (by ${input.savedBy})`
    : `Memory cancelled (by ${input.savedBy})`;
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [{ type: "TextBlock", weight: "bolder", text }],
    actions: [],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/teams exec vitest run __test__/cards.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the Teams server**

In `packages/teams/src/server.ts`:

5a. Extend the `@bean/core` import — add `memoryFile` (path helper), `saveMemories`, `MemoryProposalStore`:

```typescript
import {
  beanDir, configFile, loadConfig, makeOpenAIConverse, projectBeanDir,
  skillsDir, projectsFile, personaFile, memoryFile, modelMemoryFile, notesDir,
  loadLayeredSkills, loadProjects, loadPersona, loadMemories, loadModelMemory, saveModelMemory, saveNote, saveMemories,
  detectClis, runDelegate,
  buildTeamsBot, type BotEffects, AmbientStore, ConversationStore, MemoryProposalStore, NoteProposalStore, ProposalStore, RunRegistry,
} from "@bean/core";
```

5b. Extend the card import:

```typescript
import { finishedCard, memoryProposalCard, memoryResultCard, noteProposalCard, noteResultCard, proposalCard, runningCard } from "./cards.js";
```

5c. Add the two deps in the `buildTeamsBot({...})` call (after `saveNote`):

```typescript
  memoryProposals: new MemoryProposalStore(),
  saveMemories: (m) => saveMemories(memoryFile(dir), m),
```

5d. Add the card builders to `cards:`:

```typescript
  cards: { proposalCard, runningCard, finishedCard, noteProposalCard, noteResultCard, memoryProposalCard, memoryResultCard },
```

5e. In the `/api/messages` handler's `value?.beanAction` branch, compute `memoryPicks` and pass an explicit value object (replace the existing `bot.onCardAction({...})` call in that branch):

```typescript
    if (value?.beanAction) {
      const memoryPicks = value.beanAction === "save-memories"
        ? Object.keys(value).filter((k) => /^fact-\d+$/.test(k) && value[k] === "true").map((k) => k.slice(5))
        : undefined;
      await bot.onCardAction(
        {
          conversationId: a.conversation.id,
          fromName: a.from.name ?? "someone",
          value: {
            beanAction: value.beanAction, proposalId: value.proposalId, projectPath: value.projectPath,
            cli: value.cli, model: value.model, memoryPicks,
          },
        },
        fx,
      );
      return;
    }
```

- [ ] **Step 6: Typecheck the package and commit**

Run: `pnpm --filter @bean/teams exec tsc --noEmit`
Expected: no errors.

```bash
git add packages/teams/src/cards.ts packages/teams/src/server.ts packages/teams/__test__/cards.test.ts
git commit -m "Add memory cards and wiring to the Teams bot"
```

---

### Task 5: Discord components + server wiring

**Files:**
- Modify: `packages/discord/src/components.ts`
- Modify: `packages/discord/src/server.ts`
- Modify: `packages/discord/__test__/components.test.ts`

**Interfaces:**
- Consumes: `MemoryProposalCardInput`, `MemoryResultCardInput` from `@bean/core`; existing `BUTTON`/`STRING_SELECT`/`row` helpers.
- Produces: `discordCards.memoryProposalCard` (multi-select menu `bean:pick-memories:<id>` + Remember/Cancel buttons), `discordCards.memoryResultCard`.

- [ ] **Step 1: Write the failing component tests**

In `packages/discord/__test__/components.test.ts`:

```typescript
test("memory proposal message has a multi-select of facts and remember/cancel buttons", () => {
  const card = discordCards.memoryProposalCard({
    proposalId: "mem-1",
    facts: [{ text: "prefers tabs" }, { text: "uses vitest", projectName: "bean" }],
  }) as { components: { components: { type: number; custom_id?: string; max_values?: number; options?: unknown[] }[] }[] };
  const s = JSON.stringify(card);
  expect(s).toContain("prefers tabs");
  expect(s).toContain("bean:pick-memories:mem-1");
  expect(s).toContain("bean:save-memories:mem-1");
  expect(s).toContain("bean:cancel-memories:mem-1");
  const select = card.components[0]!.components[0]!;
  expect(select.type).toBe(3); // string select
  expect(select.max_values).toBe(2);
  expect(select.options).toHaveLength(2);
});

test("memory result message has no components and states the outcome", () => {
  const card = discordCards.memoryResultCard({ count: 2, savedBy: "scen", outcome: "saved" }) as { components: unknown[] };
  expect(card.components).toEqual([]);
  expect(JSON.stringify(card)).toContain("saved");
});

test("memory proposal clamps a long fact label to Discord's 100-char option limit", () => {
  const card = discordCards.memoryProposalCard({
    proposalId: "mem-1", facts: [{ text: "x".repeat(200) }],
  }) as { components: { components: { options?: { label: string }[] }[] }[] };
  const label = card.components[0]!.components[0]!.options![0]!.label;
  expect(label.length).toBeLessThanOrEqual(100);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/discord exec vitest run __test__/components.test.ts -t "memory"`
Expected: FAIL — `memoryProposalCard` undefined.

- [ ] **Step 3: Implement the components**

In `packages/discord/src/components.ts`:

3a. Extend the import:

```typescript
import type {
  CardBuilders, FinishedCardInput, MemoryProposalCardInput, MemoryResultCardInput,
  NoteProposalCardInput, NoteResultCardInput, ProposalCardInput, RunningCardInput,
} from "@bean/core";
```

3b. Add builders before the final `export const discordCards` line:

```typescript
// Discord select option labels are capped at 100 chars; the full fact is kept in the
// MemoryProposalStore, so Remember still saves the untruncated text.
const OPTION_LABEL_LIMIT = 100;
function clampLabel(text: string): string {
  return text.length <= OPTION_LABEL_LIMIT ? text : text.slice(0, OPTION_LABEL_LIMIT - 1) + "…";
}

function memoryProposalCard(input: MemoryProposalCardInput): object {
  const facts = input.facts.slice(0, 25); // Discord select menus allow at most 25 options
  const select = {
    type: STRING_SELECT,
    custom_id: `bean:pick-memories:${input.proposalId}`,
    placeholder: "Facts to remember",
    min_values: 0,
    max_values: facts.length,
    options: facts.map((f, i) => ({
      label: clampLabel(f.projectName ? `[${f.projectName}] ${f.text}` : f.text),
      value: String(i),
      default: true,
    })),
  };
  return {
    embeds: [{
      title: "Bean wants to remember",
      description: facts
        .map((f, i) => `${i + 1}. ${f.projectName ? `(${f.projectName}) ` : ""}${f.text}`)
        .join("\n")
        .slice(0, 4096),
    }],
    components: [
      row([select]),
      row([
        { type: BUTTON, style: 3, label: "Remember selected", custom_id: `bean:save-memories:${input.proposalId}` },
        { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-memories:${input.proposalId}` },
      ]),
    ],
  };
}

function memoryResultCard(input: MemoryResultCardInput): object {
  const title = input.outcome === "saved"
    ? `Remembered ${input.count} fact(s) (by ${input.savedBy})`
    : `Memory cancelled (by ${input.savedBy})`;
  return { embeds: [{ title }], components: [] };
}
```

3c. Add both to the exported builders object:

```typescript
export const discordCards: CardBuilders = {
  proposalCard, runningCard, finishedCard, noteProposalCard, noteResultCard, memoryProposalCard, memoryResultCard,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/discord exec vitest run __test__/components.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the Discord server**

In `packages/discord/src/server.ts`:

5a. Extend the `@bean/core` import — add `memoryFile`, `saveMemories`, `MemoryProposalStore`:

```typescript
import {
  beanDir, configFile, loadConfig, makeOpenAIConverse, projectBeanDir,
  skillsDir, projectsFile, personaFile, memoryFile, modelMemoryFile, notesDir,
  loadLayeredSkills, loadProjects, loadPersona, loadMemories, loadModelMemory, saveModelMemory, saveNote, saveMemories,
  detectClis, runDelegate,
  buildTeamsBot, ConversationStore, MemoryProposalStore, NoteProposalStore, ProposalStore, RunRegistry, type BotEffects,
} from "@bean/core";
```

5b. Add the two deps in `buildTeamsBot({...})` (after `saveNote`):

```typescript
  memoryProposals: new MemoryProposalStore(),
  saveMemories: (m) => saveMemories(memoryFile(dir), m),
```

5c. Extend the `selections` map value type (add `memoryPicks`):

```typescript
const selections = new Map<string, { cli?: string; model?: string; memoryPicks?: string[] }>();
```

5d. In the `interaction.isStringSelectMenu()` block, add the `pick-memories` case (after the `model` line):

```typescript
      if (action === "pick-memories") sel.memoryPicks = interaction.values;
```

5e. In the button dispatch, add `memoryPicks` to the forwarded value (the `onCardAction` call after `selections.delete`):

```typescript
    await bot.onCardAction(
      {
        conversationId: interaction.channelId,
        fromName: interaction.user.displayName,
        value: { beanAction: action, proposalId: payload, cli: sel.cli, model: sel.model, memoryPicks: sel.memoryPicks },
      },
      fx,
    );
```

- [ ] **Step 6: Typecheck the package and commit**

Run: `pnpm --filter @bean/discord exec tsc --noEmit`
Expected: no errors.

```bash
git add packages/discord/src/components.ts packages/discord/src/server.ts packages/discord/__test__/components.test.ts
git commit -m "Add memory cards and wiring to the Discord bot"
```

---

### Task 6: Full validation gate + memory doc

**Files:**
- Create: `.memory/project-chatops-memory-flow.md`
- Modify: `.memory/INDEX.md`

- [ ] **Step 1: Run the full validation gate**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0 across all packages.

If anything fails, fix it before continuing (do not proceed on red).

- [ ] **Step 2: Add a team-memory note**

Create `.memory/project-chatops-memory-flow.md`:

```markdown
# chatops memory capture

Teams/Discord bots can save durable memories via a confirm-first card, mirroring the notes flow.

- Trigger: a **gated** `propose_remember` tool in `converse()` (argless). Enabled only when
  `rememberAvailable` is passed (the bot passes `true`; the desktop app does NOT, so its
  extract-at-close review stays the only desktop memory path — don't remove the gate).
- The tool is a trigger only: the model decides WHEN, `extractMemories()` (run by `bot.ts`)
  decides WHAT.
- Selection is normalized to `CardAction.value.memoryPicks` (fact indices). **undefined = all**
  — this is how Discord's untouched (all-default-selected) select menu is handled. Teams always
  sends explicit `fact-<i>: "true"` toggles.
- `MemoryProposalStore.claim()` is one-shot (like NoteProposalStore) so two people tapping
  Remember can't double-save.
```

Add a link under the appropriate section of `.memory/INDEX.md`:

```markdown
- [project-chatops-memory-flow](project-chatops-memory-flow.md) — memory capture in Teams/Discord bots
```

- [ ] **Step 3: Commit**

```bash
git add .memory/project-chatops-memory-flow.md .memory/INDEX.md
git commit -m "Document chatops memory capture flow"
```

---

## Self-Review notes

- **Spec coverage:** MemoryProposalStore (T1), gated `propose_remember` + `proposedRemember` (T2), card-api types + bot `onMessage`/`onCardAction`/`handleMemoryAction` + `memoryPicks` + index export (T1/T3), Teams cards+server (T4), Discord components+server (T5), tests in every task, validation gate (T6). All spec sections mapped.
- **Type consistency:** `memoryProposalCard`/`memoryResultCard`, `MemoryProposalCardInput.facts: {text, projectName?}[]`, `MemoryResultCardInput {count, savedBy, outcome}`, `memoryPicks?: string[]`, `saveMemories(memories: Memory[])`, `MemoryProposalStore.add/claim/setCardActivityId`, ids `mem-<n>` / toggle+option `fact-<i>` / `<i>` — used identically across T1–T5.
- **`converse` arg order:** the bot call passes 14 positional args ending `..., true, detected, true` (delegateAvailable, availableClis, rememberAvailable). Verified against the existing 13-arg call.
