# Skill Self-Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Bean generate and update skills from conversation, confirm-first, in all three channels (desktop ChatWindow, Discord, Teams).

**Architecture:** A new always-offered `propose_skill` tool in core's `converse()` produces a `ProposedSkill` on `ConverseResult`. The desktop ChatWindow renders it as an editable confirm card that saves through the existing `window.bean.saveSkill()` bridge. The chatops bot (`bot.ts`, shared by Discord and Teams) posts a proposal card backed by a new one-shot `SkillProposalStore`, and a `save-skill` card action persists via a new injected `saveSkill` dep. A built-in `generate-skill` chat skill supplies authoring expertise.

**Tech Stack:** TypeScript ESM monorepo (pnpm + turbo), vitest, Preact renderer, discord.js / botbuilder card builders.

## Global Constraints

- Both packages are ESM with `verbatimModuleSyntax`: relative imports need `.js` extensions; type-only imports use `import type`.
- `strict` + `noUncheckedIndexedAccess` are on — array indexing yields `T | undefined`.
- New IO logic belongs in `@bean/core` as pure, dependency-injected functions (`.memory/convention-core-is-electron-free.md`). No Electron imports in core.
- Files are kebab-case. No ESLint/Prettier — match surrounding style.
- Validation gate: `pnpm test && pnpm typecheck` must both exit 0 before claiming done.
- Run all commands from the repo worktree root: `/Users/scenkang/Develop/Bean/.claude/worktrees/skill-self-authoring-cb1831`.

---

### Task 1: `propose_skill` tool in `converse()`

**Files:**
- Modify: `packages/core/src/converse.ts`
- Test: `packages/core/__test__/converse.test.ts`

**Interfaces:**
- Produces: `export interface ProposedSkill { name: string; body: string; updating: boolean; }` and `ConverseResult.proposedSkill?: ProposedSkill`. Later tasks (bot, ChatWindow) consume `result.proposedSkill`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__test__/converse.test.ts`:

```typescript
test("valid propose_skill call yields a proposedSkill with updating=false for a new name", async () => {
  const deps = depsReturning("Drafted it.", [
    { name: "propose_skill", args: { name: "changelog", body: "---\ndescription: Write a changelog\n---\n\n# Changelog\n\nDo the thing." } },
  ]);
  const res = await converse([], "make me a changelog skill", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(res.reply).toBe("Drafted it.");
  expect(res.proposedSkill).toEqual({
    name: "changelog",
    body: "---\ndescription: Write a changelog\n---\n\n# Changelog\n\nDo the thing.",
    updating: false,
  });
});

test("propose_skill naming an existing skill sets updating=true", async () => {
  const deps = depsReturning("Updating.", [
    { name: "propose_skill", args: { name: "review-code", body: "# Review\n\nNew body." } },
  ]);
  const res = await converse([], "improve the review skill", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(res.proposedSkill?.updating).toBe(true);
});

test("propose_skill with a traversal or empty name drops the proposal but keeps the reply", async () => {
  for (const name of ["../evil", "a/b", "a\\b", "", "  "]) {
    const deps = depsReturning("Hmm.", [{ name: "propose_skill", args: { name, body: "# X" } }]);
    const res = await converse([], "make a skill", skills, projects, DEFAULT_PERSONA, [], deps);
    expect(res.proposedSkill, name).toBeUndefined();
    expect(res.reply).toBe("Hmm.");
  }
});

test("propose_skill with a missing or empty body drops the proposal", async () => {
  const deps = depsReturning("Hmm.", [{ name: "propose_skill", args: { name: "ok" } }]);
  const res = await converse([], "make a skill", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(res.proposedSkill).toBeUndefined();
});
```

Also update the TWO existing tool-list assertions in this file (adding an always-on tool changes them):

```typescript
// in "propose_run tool is enum-constrained to known skill names and project paths":
expect(captured.map((t) => t.name)).toEqual(["propose_run", "propose_note", "propose_skill"]);
// in "no propose_run tool is offered when there are no skills":
expect(captured.map((t) => t.name)).toEqual(["propose_note", "propose_skill"]);
```

Check the rest of the file for any other assertion on the exact tools list (e.g. the `runAvailable=false` test around line 80) and add `"propose_skill"` there too — it appears after `propose_note` and before action tools.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: the 4 new tests FAIL (`proposedSkill` undefined / tool-list mismatch); previously passing tests still pass except the two updated assertions.

- [ ] **Step 3: Implement in `packages/core/src/converse.ts`**

Add the interface next to `ProposedNote` (after line 32):

```typescript
/** A skill draft awaiting user confirmation — skills are never written silently.
 * `updating` = a skill with this name already exists (user or built-in; confirming
 * writes/overrides the user copy in ~/.bean/skills). */
export interface ProposedSkill { name: string; body: string; updating: boolean; }
```

Extend `ConverseResult` (line 47):

```typescript
export interface ConverseResult { reply: string; model?: string; proposedRun?: ProposedRun; proposedNote?: ProposedNote; proposedDelegate?: ProposedDelegate; proposedRemember?: boolean; proposedSkill?: ProposedSkill; }
```

Add the tool builder after `proposeNoteTool` (~line 116):

```typescript
// Mirrors saveSkill's traversal guard — converse() must reject what the writer would reject,
// so an invalid model-supplied name dies here instead of as a save-time error on the card.
const INVALID_SKILL_NAME = /[/\\]|\.\./;

function proposeSkillTool(): ToolSpec {
  return {
    name: "propose_skill",
    description:
      "Draft a new skill, or a new version of an existing one, for the user to confirm and save. " +
      "A skill is a markdown file: optional frontmatter (`description:` — the one-line summary " +
      "shown in catalogs; `target: chat` if it should run right in the chat instead of a " +
      "terminal coding agent), then the full instructions as the body. Reusing an existing " +
      "skill's name replaces that skill. Nothing is written until the user confirms the card.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "kebab-case skill name; becomes the filename <name>.md" },
        body: { type: "string", description: "the complete markdown file content, frontmatter included" },
      },
      required: ["name", "body"],
    },
  };
}
```

Register it in the `tools` array (line 270), always on, after `proposeNoteTool`:

```typescript
    proposeNoteTool(projects, linkedNote),
    proposeSkillTool(),
```

Handle the call in the loop, after the `noteCall` block (~line 350):

```typescript
    const skillCall = toolCalls.find((c) => c.name === "propose_skill");
    if (skillCall) {
      const args = (skillCall.args ?? {}) as { name?: unknown; body?: unknown };
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name || INVALID_SKILL_NAME.test(name) || typeof args.body !== "string" || !args.body.trim()) {
        return { reply: content, model: deps.model };
      }
      return {
        reply: content,
        model: deps.model,
        proposedSkill: { name, body: args.body, updating: skills.some((s) => s.name === name) },
      };
    }
```

Append one sentence to `behaviorInstructions` (end of the string, after the propose_remember sentence):

```typescript
  " When the user asks you to create a new skill or change an existing one, call propose_skill " +
  "with the complete markdown — the user confirms the card before anything is written.";
```

(Attach it by replacing the current final `;` — keep it a single template of concatenated strings like the rest.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/converse.ts packages/core/__test__/converse.test.ts
git commit -m "feat(core): propose_skill tool — confirm-first skill drafts from converse()"
```

---

### Task 2: Built-in `generate-skill` skill

**Files:**
- Create: `.bean/skills/generate-skill.md`
- Test: `packages/core/__test__/builtin-skills.test.ts`

**Interfaces:**
- Produces: a `target: chat` built-in skill named `generate-skill`, loaded by `loadLayeredSkills` everywhere automatically. No code consumes it by name.

- [ ] **Step 1: Update the failing tests**

In `packages/core/__test__/builtin-skills.test.ts`, the shipped-skills list test must include the new name (sorted):

```typescript
  expect(skills.map((s) => s.name).sort()).toEqual([
    "draft-reply", "explain", "extract-tasks", "generate-skill", "review-pr", "summarize"
  ]);
```

And add `"generate-skill"` to the chat-target loop:

```typescript
  for (const name of ["summarize", "explain", "draft-reply", "extract-tasks", "generate-skill"]) {
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bean/core exec vitest run __test__/builtin-skills.test.ts`
Expected: FAIL (missing `generate-skill`).

- [ ] **Step 3: Create `.bean/skills/generate-skill.md`**

```markdown
---
target: chat
description: Draft a new Bean skill (or improve an existing one) and propose it for saving
---

# Generate Skill

You are authoring a Bean skill. A skill is one markdown file in `~/.bean/skills/<name>.md`:

- Optional frontmatter between `---` fences:
  - `description:` — one line; this is what the router sees when picking skills, so make it
    concrete about *when* to use the skill, not just what it is.
  - `target: chat` — only if the skill should run directly in the chat on Bean's own model
    (summaries, drafting, explaining). Omit it for skills meant for a terminal coding agent.
- Body — the full instructions. Write for the agent that will execute them: state the goal,
  the steps, the output format, and what to avoid. Keep it short; every line should earn its place.

Process:

1. Ask what the skill should do if the request is vague — one clarifying question at most.
2. Draft the complete file. Reuse an existing skill's exact name only when the user wants
   that skill changed; otherwise pick a fresh kebab-case name.
3. Call `propose_skill` with the name and the complete markdown body. The user confirms the
   card before anything is saved — never claim the skill is saved yourself.
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @bean/core exec vitest run __test__/builtin-skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .bean/skills/generate-skill.md packages/core/__test__/builtin-skills.test.ts
git commit -m "feat: built-in generate-skill chat skill for authoring other skills"
```

---

### Task 3: `SkillProposalStore`

**Files:**
- Create: `packages/core/src/chatops/skill-proposals.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/__test__/chatops-skill-proposals.test.ts`

**Interfaces:**
- Produces: `class SkillProposalStore` with `add(p: Omit<PendingSkill, "id" | "createdAt">): PendingSkill`, `setCardActivityId(id: string, activityId: string): void`, `claim(id: string): PendingSkill | undefined`; `PendingSkill { id; skill: ProposedSkill; conversationId; proposedBy; cardActivityId?; createdAt }`. Task 4's bot deps consume it.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__test__/chatops-skill-proposals.test.ts`:

```typescript
import { expect, test } from "vitest";
import { SkillProposalStore } from "../src/chatops/skill-proposals.js";

const base = {
  skill: { name: "changelog", body: "# Changelog", updating: false },
  conversationId: "c1",
  proposedBy: "alice",
};

test("add assigns unique ids and claim is one-shot", () => {
  const s = new SkillProposalStore(() => 0);
  const a = s.add(base);
  const b = s.add(base);
  expect(a.id).not.toBe(b.id);
  expect(s.claim(a.id)?.skill.name).toBe("changelog");
  expect(s.claim(a.id)).toBeUndefined(); // already claimed
});

test("claim returns undefined after the 10-minute expiry", () => {
  let now = 0;
  const s = new SkillProposalStore(() => now);
  const p = s.add(base);
  now = 10 * 60_000 + 1;
  expect(s.claim(p.id)).toBeUndefined();
});

test("setCardActivityId records the card message id for later edits", () => {
  const s = new SkillProposalStore(() => 0);
  const p = s.add(base);
  s.setCardActivityId(p.id, "act-9");
  expect(s.claim(p.id)?.cardActivityId).toBe("act-9");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-skill-proposals.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `packages/core/src/chatops/skill-proposals.ts`**

```typescript
import type { ProposedSkill } from "../converse.js";

/** A pending confirm-first skill draft awaiting a Save/Cancel tap on its card. */
export interface PendingSkill {
  id: string;
  skill: ProposedSkill;
  conversationId: string;
  proposedBy: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending confirm-first skill proposals — the skill counterpart to NoteProposalStore.
 * claim() is one-shot so two members tapping Save on the same card can't double-save. */
export class SkillProposalStore {
  private byId = new Map<string, PendingSkill>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingSkill, "id" | "createdAt">): PendingSkill {
    const full: PendingSkill = { ...p, id: `skill-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  claim(id: string): PendingSkill | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
```

In `packages/core/src/index.ts`, after `export * from "./chatops/note-proposals.js";` add:

```typescript
export * from "./chatops/skill-proposals.js";
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-skill-proposals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chatops/skill-proposals.ts packages/core/src/index.ts packages/core/__test__/chatops-skill-proposals.test.ts
git commit -m "feat(core): SkillProposalStore for confirm-first chatops skill drafts"
```

---

### Task 4: Card API types + bot flow

**Files:**
- Modify: `packages/core/src/chatops/cards-api.ts`
- Modify: `packages/core/src/chatops/bot.ts`
- Test: `packages/core/__test__/chatops-bot.test.ts`

**Interfaces:**
- Consumes: `SkillProposalStore`/`PendingSkill` (Task 3), `ConverseResult.proposedSkill` (Task 1).
- Produces (Tasks 5–6 consume these):
  - `SkillProposalCardInput { proposalId: string; name: string; body: string; updating: boolean }`
  - `SkillResultCardInput { name: string; savedBy: string; outcome: "saved" | "cancelled" }`
  - `CardBuilders.skillProposalCard` / `CardBuilders.skillResultCard`
  - `TeamsBotDeps.skillProposals: SkillProposalStore` and `TeamsBotDeps.saveSkill: (name: string, body: string) => Promise<void>`
  - Card action ids `save-skill` / `cancel-skill` handled in `onCardAction`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/__test__/chatops-bot.test.ts`:

1. Add to imports: `import { SkillProposalStore } from "../src/chatops/skill-proposals.js";`
2. Extend `fakeCards`:

```typescript
  skillProposalCard: (i: object) => ({ kind: "skill-proposal", ...i }),
  skillResultCard: (i: object) => ({ kind: "skill-result", ...i }),
```

3. In `makeDeps`, add a `savedSkills` collector and the two new deps (put `savedSkills` next to `savedNotes`, deps next to `saveNote`):

```typescript
  const savedSkills: { name: string; body: string }[] = [];
  // ...inside deps:
    skillProposals: new SkillProposalStore(),
    saveSkill: async (name, body) => { savedSkills.push({ name, body }); },
  // ...and return it:
  return { deps, delegateCalls, saved, savedNotes, savedMemories, savedSkills };
```

4. The existing fake `chat` fn only emits delegate tool calls; extend it to emit a skill call when the test's `converseResult` carries one. Replace the `chat` value with:

```typescript
    chat: async () => {
      if (result.proposedSkill) {
        return { content: result.reply, toolCalls: [{ name: "propose_skill", args: {
          name: result.proposedSkill.name, body: result.proposedSkill.body,
        } }] };
      }
      return result.proposedDelegate
        ? { content: result.reply, toolCalls: [{ name: "propose_delegate", args: {
            project: result.proposedDelegate.projectPath,
            instruction: result.proposedDelegate.instruction,
          } }] }
        : { content: result.reply, toolCalls: [] };
    },
```

5. Append tests:

```typescript
test("proposedSkill posts a skill proposal card and stores the pending draft", async () => {
  const { deps } = makeDeps({
    converseResult: { reply: "Drafted.", proposedSkill: { name: "changelog", body: "# C", updating: false } },
  });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onMessage(msg, effects);
  const card = effects.cards[0] as { kind: string; name: string; updating: boolean; proposalId: string };
  expect(card.kind).toBe("skill-proposal");
  expect(card.name).toBe("changelog");
  expect(card.updating).toBe(false);
  expect(card.proposalId).toBeTruthy();
});

test("save-skill action persists the skill and updates the card to saved", async () => {
  const { deps, savedSkills } = makeDeps();
  const bot = buildTeamsBot(deps);
  const pending = deps.skillProposals.add({
    skill: { name: "changelog", body: "# C", updating: false }, conversationId: "c1", proposedBy: "alice",
  });
  deps.skillProposals.setCardActivityId(pending.id, "act-1");
  const effects = fx();
  await bot.onCardAction({ conversationId: "c1", fromName: "bob", value: { beanAction: "save-skill", proposalId: pending.id } }, effects);
  expect(savedSkills).toEqual([{ name: "changelog", body: "# C" }]);
  expect(effects.updates[0]?.card).toMatchObject({ kind: "skill-result", outcome: "saved", savedBy: "bob" });
  expect(effects.posted[0]).toContain("changelog");
});

test("cancel-skill action updates the card to cancelled without saving", async () => {
  const { deps, savedSkills } = makeDeps();
  const bot = buildTeamsBot(deps);
  const pending = deps.skillProposals.add({
    skill: { name: "changelog", body: "# C", updating: false }, conversationId: "c1", proposedBy: "alice",
  });
  deps.skillProposals.setCardActivityId(pending.id, "act-1");
  const effects = fx();
  await bot.onCardAction({ conversationId: "c1", fromName: "bob", value: { beanAction: "cancel-skill", proposalId: pending.id } }, effects);
  expect(savedSkills).toEqual([]);
  expect(effects.updates[0]?.card).toMatchObject({ kind: "skill-result", outcome: "cancelled" });
});

test("save-skill on an expired/unknown proposal posts an expiry message", async () => {
  const { deps, savedSkills } = makeDeps();
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onCardAction({ conversationId: "c1", fromName: "bob", value: { beanAction: "save-skill", proposalId: "nope" } }, effects);
  expect(savedSkills).toEqual([]);
  expect(effects.posted[0]).toContain("expired");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-bot.test.ts`
Expected: FAIL (TS: `skillProposals`/`saveSkill` not in `TeamsBotDeps`).

- [ ] **Step 3: Implement**

`packages/core/src/chatops/cards-api.ts` — after `NoteResultCardInput` add:

```typescript
export interface SkillProposalCardInput {
  proposalId: string;
  name: string;
  body: string;
  /** True when a skill with this name already exists (save replaces/overrides it). */
  updating: boolean;
}

export interface SkillResultCardInput {
  name: string;
  savedBy: string;
  outcome: "saved" | "cancelled";
}
```

And extend `CardBuilders` (after `noteResultCard`):

```typescript
  skillProposalCard: (input: SkillProposalCardInput) => object;
  skillResultCard: (input: SkillResultCardInput) => object;
```

`packages/core/src/chatops/bot.ts`:

1. Import the store type: `import type { SkillProposalStore } from "./skill-proposals.js";`
2. Add to `TeamsBotDeps` (after `searchNotes`):

```typescript
  skillProposals: SkillProposalStore;
  /** Persists a confirmed skill draft to the user's ~/.bean/skills (server injects the dir). */
  saveSkill: (name: string, body: string) => Promise<void>;
```

3. Add a handler next to `handleNoteAction`:

```typescript
  async function handleSkillAction(
    kind: "save-skill" | "cancel-skill",
    proposalId: string | undefined,
    actor: string,
    fx: BotEffects,
  ): Promise<void> {
    if (!proposalId) return;
    const pending = deps.skillProposals.claim(proposalId);
    if (!pending) {
      await fx.post("That skill draft expired — ask me to draft it again.");
      return;
    }
    const resultCard = (outcome: "saved" | "cancelled"): object =>
      deps.cards.skillResultCard({ name: pending.skill.name, savedBy: actor, outcome });
    const updateTo = async (card: object): Promise<void> => {
      if (pending.cardActivityId !== undefined) await fx.updateCard(pending.cardActivityId, card);
    };
    if (kind === "cancel-skill") {
      await updateTo(resultCard("cancelled"));
      return;
    }
    try {
      await deps.saveSkill(pending.skill.name, pending.skill.body);
      await updateTo(resultCard("saved"));
      await fx.post(`Saved skill "${pending.skill.name}".`);
    } catch (err) {
      await fx.post(`Couldn't save the skill: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

4. In `onMessage`, after the `result.proposedNote` block and before `result.proposedRemember`:

```typescript
        if (result.proposedSkill) {
          const skill = result.proposedSkill;
          const pending = deps.skillProposals.add({ skill, conversationId: msg.conversationId, proposedBy: msg.fromName });
          const activityId = await fx.postCard(deps.cards.skillProposalCard({
            proposalId: pending.id, name: skill.name, body: skill.body, updating: skill.updating,
          }));
          deps.skillProposals.setCardActivityId(pending.id, activityId);
          return;
        }
```

5. In `onCardAction`, after the note branch:

```typescript
      if (beanAction === "save-skill" || beanAction === "cancel-skill") {
        await handleSkillAction(beanAction, proposalId, action.fromName, fx);
        return;
      }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-bot.test.ts && pnpm --filter @bean/core test && pnpm --filter @bean/core exec tsc --noEmit`
Expected: PASS / exit 0. (Note: `@bean/discord` and `@bean/teams` will now fail `pnpm typecheck` at the root until Tasks 5–6 wire the new deps — that's expected mid-stream; the root gate runs at the end.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chatops/cards-api.ts packages/core/src/chatops/bot.ts packages/core/__test__/chatops-bot.test.ts
git commit -m "feat(core): confirm-first skill proposal flow in the chatops bot"
```

---

### Task 5: Discord cards + server wiring

**Files:**
- Modify: `packages/discord/src/components.ts`
- Modify: `packages/discord/src/server.ts`
- Test: none new (components are covered transitively by core bot tests; Discord has no components test file today — follow the existing pattern).

**Interfaces:**
- Consumes: `SkillProposalCardInput`/`SkillResultCardInput`/`CardBuilders` (Task 4), `SkillProposalStore` (Task 3), core `saveSkill(dir, name, body)` and `skillsDir(dir)`.
- Produces: `discordCards.skillProposalCard`/`skillResultCard`; button custom_ids `bean:save-skill:<id>` / `bean:cancel-skill:<id>` (already routed by the server's generic `/^bean:([a-z-]+):(.*)$/` dispatch — no server interaction changes needed).

- [ ] **Step 1: Implement `packages/discord/src/components.ts`**

Add `SkillProposalCardInput, SkillResultCardInput` to the type import from `@bean/core`. After `noteResultCard` add (reusing the existing `noteDescription` clamp helper — same 4096 limit applies):

```typescript
function skillProposalCard(input: SkillProposalCardInput): object {
  return {
    embeds: [{
      title: input.updating ? "Bean proposes a skill update" : "Bean proposes a new skill",
      description: noteDescription(input.name, `\`\`\`markdown\n${input.body}\n\`\`\``),
      fields: [{ name: "Skill", value: input.updating ? `${input.name} (replaces existing)` : input.name, inline: true }],
    }],
    components: [row([
      { type: BUTTON, style: 3, label: input.updating ? "Update skill" : "Save skill", custom_id: `bean:save-skill:${input.proposalId}` },
      { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-skill:${input.proposalId}` },
    ])],
  };
}

function skillResultCard(input: SkillResultCardInput): object {
  return {
    embeds: [{ title: `Skill ${input.outcome} (by ${input.savedBy})`, description: input.name }],
    components: [],
  };
}
```

Add both to the `discordCards` export object.

- [ ] **Step 2: Wire `packages/discord/src/server.ts`**

Add `saveSkill` (core) and `SkillProposalStore` to the `@bean/core` import list. In the `buildTeamsBot({...})` deps, after `searchNotes`:

```typescript
  skillProposals: new SkillProposalStore(),
  saveSkill: (name, body) => saveSkill(skillsDir(dir), name, body),
```

(`skillsDir` is already imported. No `interactionCreate` change: `save-skill`/`cancel-skill` match the existing `[a-z-]+` action regex and flow through the generic `onCardAction` call.)

- [ ] **Step 3: Verify it builds**

Run: `pnpm --filter @bean/discord build && pnpm --filter @bean/discord exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/discord/src/components.ts packages/discord/src/server.ts
git commit -m "feat(discord): skill proposal/result cards and saveSkill wiring"
```

---

### Task 6: Teams cards + server wiring

**Files:**
- Modify: `packages/teams/src/cards.ts`
- Modify: `packages/teams/src/server.ts`
- Test: `packages/teams/__test__/cards.test.ts`

**Interfaces:**
- Consumes: same as Task 5.
- Produces: `skillProposalCard`/`skillResultCard` adaptive-card builders with `Action.Submit` data `{ beanAction: "save-skill" | "cancel-skill", proposalId }` (already routed by the server's generic `value.beanAction` dispatch).

- [ ] **Step 1: Write the failing tests**

Append to `packages/teams/__test__/cards.test.ts` (add `skillProposalCard, skillResultCard` to the import):

```typescript
test("skill proposal card shows name and body and wires save/cancel data", () => {
  const card = skillProposalCard({ proposalId: "skill-1", name: "changelog", body: "# Changelog\n\nDo it.", updating: false });
  const s = flatten(card);
  expect(s).toContain("changelog");
  expect(s).toContain("Do it.");
  expect(s).toContain('"beanAction":"save-skill"');
  expect(s).toContain('"beanAction":"cancel-skill"');
  expect(s).toContain('"proposalId":"skill-1"');
  expect(s).not.toContain("replaces existing");
});

test("skill proposal card badges an update to an existing skill", () => {
  const s = flatten(skillProposalCard({ proposalId: "p", name: "summarize", body: "# S", updating: true }));
  expect(s).toContain("replaces existing");
});

test("skill result card reports outcome and actor", () => {
  const s = flatten(skillResultCard({ name: "changelog", savedBy: "alice", outcome: "saved" }));
  expect(s).toContain("Skill saved");
  expect(s).toContain("alice");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bean/teams exec vitest run __test__/cards.test.ts`
Expected: FAIL (no such export).

- [ ] **Step 3: Implement `packages/teams/src/cards.ts`**

Add `SkillProposalCardInput, SkillResultCardInput` to the type import. After `noteResultCard`:

```typescript
/** Confirm-first skill draft: name, full markdown body, Save/Cancel.
 * data comes back merged into the Action.Submit payload as beanAction + proposalId. */
export function skillProposalCard(input: SkillProposalCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", size: "medium", weight: "bolder", text: input.updating ? "Bean proposes a skill update" : "Bean proposes a new skill" },
      { type: "FactSet", facts: [{ title: "Skill", value: input.updating ? `${input.name} (replaces existing)` : input.name }] },
      { type: "TextBlock", text: input.body, wrap: true, fontType: "monospace" },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: input.updating ? "Update skill" : "Save skill",
        style: "positive",
        data: { beanAction: "save-skill", proposalId: input.proposalId },
      },
      { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-skill", proposalId: input.proposalId } },
    ],
  };
}

export function skillResultCard(input: SkillResultCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", weight: "bolder", text: `Skill ${input.outcome} (by ${input.savedBy})` },
      { type: "TextBlock", text: input.name, wrap: true, isSubtle: true },
    ],
    actions: [],
  };
}
```

- [ ] **Step 4: Wire `packages/teams/src/server.ts`**

- Add `saveSkill` and `SkillProposalStore` to the `@bean/core` import.
- Add `skillProposalCard, skillResultCard` to the `./cards.js` import.
- In `buildTeamsBot({...})` deps, after `searchNotes`:

```typescript
  skillProposals: new SkillProposalStore(),
  saveSkill: (name, body) => saveSkill(skillsDir(dir), name, body),
```

- Add `skillProposalCard, skillResultCard` to the inline `cards: { ... }` object.

(No `/api/messages` change: `save-skill`/`cancel-skill` arrive as `value.beanAction` and flow through the existing generic dispatch.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @bean/teams test && pnpm --filter @bean/teams exec tsc --noEmit`
Expected: PASS / exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/teams/src/cards.ts packages/teams/src/server.ts packages/teams/__test__/cards.test.ts
git commit -m "feat(teams): skill proposal/result adaptive cards and saveSkill wiring"
```

---

### Task 7: Desktop ChatWindow card

**Files:**
- Modify: `packages/app/src/renderer/shared/chat-types.ts`
- Create: `packages/app/src/renderer/components/chat/SkillCard.tsx`
- Modify: `packages/app/src/renderer/components/chat/ChatPanel.tsx`
- Modify: `packages/app/src/renderer/components/chat/ChatWindow.tsx`
- Test: `packages/app/__test__/chat-types.test.ts` only if it asserts on the `ChatItem` union (check first: `grep -l ChatItem packages/app/__test__/`); otherwise no new app test — the app package has no component tests, and the confirm path reuses the already-wired `window.bean.saveSkill()` bridge (`preload.ts:67`, handler `buildSaveSkillHandler` in `ipc.ts`; no IPC changes).

**Interfaces:**
- Consumes: `ProposedSkill` from `@bean/core` (Task 1); `window.bean.saveSkill(name, body)` (exists, `bean.d.ts:51`).
- Produces: `ChatItem` variant `{ kind: "skill"; id: string; skill: ProposedSkill; state: "pending" | "saved" | "dismissed" }`; `SkillCard` component `{ skill, state, onSave: (edited: ProposedSkill) => void, onDismiss: () => void }`.

- [ ] **Step 1: Add the ChatItem variant**

In `packages/app/src/renderer/shared/chat-types.ts`, add `ProposedSkill` to the type import and a union member after the `note` variant:

```typescript
  // A propose_skill draft awaiting confirmation — skills are never written silently.
  | { kind: "skill"; id: string; skill: ProposedSkill; state: "pending" | "saved" | "dismissed" }
```

- [ ] **Step 2: Create `packages/app/src/renderer/components/chat/SkillCard.tsx`**

Modeled on `NoteCard.tsx` (editable until confirmed):

```tsx
import { useState } from "preact/hooks";
import type { ProposedSkill } from "@bean/core";

/** Draft-skill confirm card: name and body editable until confirmed. skill.updating =
 * a skill with this name already exists, so Save replaces/overrides it. */
export function SkillCard({
  skill,
  state,
  onSave,
  onDismiss,
}: {
  skill: ProposedSkill;
  state: "pending" | "saved" | "dismissed";
  onSave: (edited: ProposedSkill) => void;
  onDismiss: () => void;
}) {
  const [name, setName] = useState(skill.name);
  const [body, setBody] = useState(skill.body);
  const done = state !== "pending";

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">{skill.updating ? "update skill" : "draft skill"}</span>
        {skill.updating ? <span class="bean-chip">replaces existing</span> : null}
      </div>
      <input
        class="bean-input bean-input--boxed"
        type="text"
        value={name}
        disabled={done}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <textarea
        class="bean-card-prompt"
        value={body}
        disabled={done}
        onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
      />
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={done} onClick={() => onSave({ ...skill, name, body })}>
          {state === "saved" ? "Saved" : skill.updating ? "Update skill" : "Save skill"}
        </button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={done} onClick={onDismiss}>
          {state === "dismissed" ? "Dismissed" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Render it in `ChatPanel.tsx`**

- Import: `import { SkillCard } from "./SkillCard.js";` and add `ProposedSkill` to the `@bean/core` type import.
- Add props `onSkillSave: (id: string, edited: ProposedSkill) => void;` and `onSkillDismiss: (id: string) => void;` (both to the destructuring and the type).
- In the `items.map`, after the `note` branch:

```tsx
          if (it.kind === "skill") {
            return (
              <SkillCard
                key={it.id}
                skill={it.skill}
                state={it.state}
                onSave={(edited) => onSkillSave(it.id, edited)}
                onDismiss={() => onSkillDismiss(it.id)}
              />
            );
          }
```

- [ ] **Step 4: Handle it in `ChatWindow.tsx`**

- In `sendMessage`'s result handling, after the `res.proposedNote` line:

```typescript
        if (res.proposedSkill) next.push({ kind: "skill", id: newId(), skill: res.proposedSkill, state: "pending" });
```

- Add handlers next to `saveNote`/`dismissNote` (add `ProposedSkill` to the `@bean/core` type import):

```typescript
  const saveSkill = async (id: string, edited: ProposedSkill): Promise<void> => {
    try {
      await window.bean.saveSkill(edited.name, edited.body);
      setItems((prev) => [
        ...prev.map((it) => (it.id === id && it.kind === "skill" ? { ...it, state: "saved" as const } : it)),
        { kind: "status", id: newId(), text: `✓ Saved skill — "${edited.name}"`, tone: "done" },
      ]);
    } catch (err) {
      setItems((prev) => [...prev, { kind: "status", id: newId(), text: `Couldn't save the skill: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }]);
    }
  };

  const dismissSkill = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "skill" ? { ...it, state: "dismissed" } : it)));
  };
```

- Pass them to `<ChatPanel>`:

```tsx
        onSkillSave={(id, edited) => void saveSkill(id, edited)}
        onSkillDismiss={dismissSkill}
```

- [ ] **Step 5: Build and typecheck the app package**

Run: `pnpm --filter @bean/app build && pnpm --filter @bean/app exec tsc --noEmit && pnpm --filter @bean/app test`
Expected: exit 0 / PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/renderer/shared/chat-types.ts packages/app/src/renderer/components/chat/SkillCard.tsx packages/app/src/renderer/components/chat/ChatPanel.tsx packages/app/src/renderer/components/chat/ChatWindow.tsx
git commit -m "feat(app): SkillCard confirm-first rendering for proposed skills in ChatWindow"
```

---

### Task 8: Full validation gate + team memory note

**Files:**
- Create: `.memory/project-skill-self-authoring.md`
- Modify: `.memory/INDEX.md`

- [ ] **Step 1: Run the full gate from the repo root**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0 across all packages. Fix anything that fails before proceeding.

- [ ] **Step 2: Build everything (chatops servers are spawned from `packages/*/dist`)**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 3: Add the team-memory entry**

Create `.memory/project-skill-self-authoring.md`:

```markdown
# Skill self-authoring (propose_skill)

`converse()` offers `propose_skill` on every call (all channels). It is confirm-first like
notes: `ConverseResult.proposedSkill` → SkillCard (desktop) or skillProposalCard +
SkillProposalStore (chatops) → `saveSkill(skillsDir(~/.bean), name, body)`. Name validation in
converse mirrors saveSkill's traversal guard — keep them in sync. The built-in
`.bean/skills/generate-skill.md` (target: chat) is the authoring-expertise skill; adding any
built-in skill requires updating `builtin-skills.test.ts`'s shipped-list assertion, and adding
any always-on converse tool requires updating converse.test.ts's tool-list assertions.
```

Link it from `.memory/INDEX.md` following the file's existing format.

- [ ] **Step 4: Commit**

```bash
git add .memory/project-skill-self-authoring.md .memory/INDEX.md
git commit -m "docs(memory): skill self-authoring flow notes"
```
