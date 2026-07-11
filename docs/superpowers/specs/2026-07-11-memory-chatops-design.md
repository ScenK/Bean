# Memory capture in Teams/Discord — design

## Goal

Let Bean save durable memories (one-line facts about the user or a project) from
the Teams and Discord chatops bots, via a confirm-first card — the memory
counterpart to the notes flow shipped in #27. The desktop app already captures
memory at chat-close; chatops has no close event, so this wires an equivalent
in-conversation path.

## Decisions (locked)

1. **Reuse `extractMemories()`** for the "what to remember" logic — no new extraction path.
2. **Trigger: a gated `propose_remember` tool** in `converse()`. The model calls it
   only on an explicit user ask ("remember this", "save what we figured out"). Not a
   keyword match (brittle in group channels where an @mention shifts the phrasing) and
   not proactive.
3. **Per-item selection** on the card: the user picks which candidate facts to keep.
4. Scope: Teams **and** Discord.

## Flow

```
user @Bean "remember what we discussed"
  → converse(): model calls propose_remember (argless) → ConverseResult.proposedRemember = true
  → bot: extractMemories(transcript, existing, projects) → MemoryCandidate[]
      → none: post "Nothing here worth remembering long-term."
      → some: MemoryProposalStore.add(candidates); post memoryProposalCard (facts, each selectable)
  → user selects facts + taps "Remember selected"
  → bot.onCardAction("save-memories", proposalId, memoryPicks)
      → claim proposal; pick selected candidates; saveMemories([...existing, ...additions])
      → update card → memoryResultCard("saved", count); post "Remembered N fact(s)."
  → "Cancel" → memoryResultCard("cancelled"), nothing saved
```

`propose_remember` is a **trigger only** — argless. The model decides *when*;
`extractMemories()` decides *what*. This keeps a single extraction implementation.

## Gating (why the desktop app is unaffected)

`converse()` is shared with the desktop renderer, which has its own extract-at-close
memory review. Adding `propose_remember` unconditionally would give desktop a second,
conflicting memory path. So the tool is gated behind a new `rememberAvailable`
parameter (default `false`). The bot passes `true`; desktop passes nothing → the tool
never appears there.

## Changes

### `@bean/core`

- **`converse.ts`**
  - `ConverseResult` gains `proposedRemember?: boolean`.
  - New `proposeRememberTool()`: argless (`parameters: { type: "object", properties: {} }`),
    description restricting it to explicit user asks to remember/save durable facts.
  - New `converse()` param `rememberAvailable = false`; when true, the tool is added to `tools`.
  - Tool-loop: a `propose_remember` call short-circuits `→ { reply: content, proposedRemember: true }`
    (mirrors the `propose_note` branch).
  - `BEHAVIOR_INSTRUCTIONS`: one sentence — call `propose_remember` when the user explicitly
    asks to remember/save durable facts; the user confirms which are kept.

- **`chatops/memory-proposals.ts`** (new) — `MemoryProposalStore`, a direct copy of
  `NoteProposalStore`:
  - `PendingMemory { id: `mem-<n>`; candidates: MemoryCandidate[]; conversationId; proposedBy; cardActivityId?; createdAt }`
  - `add`, `setCardActivityId`, one-shot `claim`, 10-min expiry, injectable clock.

- **`chatops/cards-api.ts`**
  - `MemoryProposalCardInput { proposalId: string; facts: { text: string; projectName?: string }[] }`
  - `MemoryResultCardInput { count: number; savedBy: string; outcome: "saved" | "cancelled" }`
  - `CardBuilders` gains `memoryProposalCard` and `memoryResultCard`.

- **`chatops/bot.ts`**
  - `TeamsBotDeps` gains `memoryProposals: MemoryProposalStore` and
    `saveMemories: (memories: Memory[]) => Promise<void>`. `extractMemories` is imported
    directly (pure core fn) — no dep needed.
  - `CardAction.value` gains `memoryPicks?: string[]` — a neutral list of selected fact
    indices (`"0"`, `"1"`, …). **`undefined` = all** (covers Discord's untouched menu).
  - `onMessage`: pass `rememberAvailable: true` to `converse()`. After the `proposedNote`
    branch, handle `result.proposedRemember`:
    - `extractMemories([...history, {role:"user", content: msg.text}], memories, projects, {chat, model})`
    - empty → `fx.post("Nothing here worth remembering long-term.")`, return.
    - else → `memoryProposals.add(...)`, `postCard(memoryProposalCard(...))` with per-fact
      resolved `projectName`, `setCardActivityId`, return.
  - `onCardAction`: `save-memories` / `cancel-memories` → new `handleMemoryAction`:
    - claim; missing → post expired message.
    - cancel → update card to `memoryResultCard("cancelled")`.
    - save → selected = `memoryPicks === undefined ? all : candidates.at(each index)`; if none,
      update card to cancelled + post "Didn't remember anything." Else build `Memory[]`
      (`id: `${Date.now()}-${i}``, text, projectPath, createdAt), `saveMemories([...existing, ...additions])`,
      update card to `memoryResultCard("saved", count)`, post "Remembered N fact(s)."

- **`index.ts`** — export `chatops/memory-proposals.js`.

### `@bean/teams`

- **`cards.ts`** — `memoryProposalCard`: title + one `Input.Toggle` per fact (id `fact-<i>`,
  value `"true"`, default on; label = fact text, project shown), actions "Remember selected"
  (`beanAction: save-memories`) / "Cancel" (`beanAction: cancel-memories`). `memoryResultCard`:
  states outcome + count, no actions.
- **`server.ts`** — import `MemoryProposalStore`, `saveMemories`; add deps
  `memoryProposals: new MemoryProposalStore()`, `saveMemories: (m) => saveMemories(memoryFile(dir), m)`,
  and the two card builders. In the card-action path, when `beanAction === "save-memories"`,
  build `memoryPicks` by scanning `a.value` for keys `/^fact-(\d+)$/` whose value is `"true"`.

### `@bean/discord`

- **`components.ts`** — `memoryProposalCard`: embed listing facts + a string select menu
  (`custom_id: bean:pick-memories:<proposalId>`, `min_values: 0`, `max_values: N`, one option
  per fact with `value` = index, all `default: true`) + buttons "Remember selected"
  (`bean:save-memories:<id>`) / "Cancel" (`bean:cancel-memories:<id>`). Clamp option labels to
  Discord's 100-char limit. `memoryResultCard`: embed, no components.
- **`server.ts`** — import `MemoryProposalStore`, `saveMemories`; add the two deps.
  Extend the `selections` Map value with `memoryPicks?: string[]`; on select action
  `pick-memories`, store `interaction.values`. On the `save-memories`/`cancel-memories` button,
  pass `memoryPicks: sel.memoryPicks` through to `onCardAction` (undefined when the menu was
  never touched → bot defaults to all).

## Tests (mirroring #27)

- `core/__test__/chatops-memory-proposals.test.ts` — store: unique `mem-*` ids, one-shot claim,
  expiry, `setCardActivityId`, unknown-id claim.
- `core/__test__/chatops-bot.test.ts` — add fake `memoryProposalCard`/`memoryResultCard`;
  a `propose_remember` chat + an `extractMemories` `remember` chat: card posted; save-memories
  saves the picked subset; `memoryPicks` undefined saves all; cancel-memories saves nothing;
  expired proposal saves nothing + posts a message; empty extraction posts the "nothing" message.
- `teams/__test__/cards.test.ts` — `memoryProposalCard` shows facts + wires save/cancel data and
  `fact-<i>` toggles; `memoryResultCard` states outcome, no actions.
- `discord/__test__/components.test.ts` — `memoryProposalCard` select menu + save/cancel customIds;
  `memoryResultCard` no components; long fact label clamped to 100 chars.

## Validation

`pnpm test && pnpm typecheck` exit 0. This change is bot/IPC-adjacent but core-logic only
(no packaged-app resource paths), so dev-mode + unit tests are sufficient per AGENTS.md.

## Deliberately skipped (per answers)

- All-or-nothing card, model-decided *keyword*, proactive offering, a fact-carrying tool.
