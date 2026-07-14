# Skill Self-Authoring — Design

**Date:** 2026-07-14
**Status:** Approved

## Goal

Let Bean generate and update skills from conversation, in every channel (desktop ChatWindow,
Discord, Teams). "Skills generate other skills": a built-in `generate-skill` skill provides the
authoring expertise; a new always-available `propose_skill` tool provides the mechanism. All
writes are **confirm-first** — Bean drafts, the user approves, then the skill is saved to
`~/.bean/skills/<name>.md`.

## Scope

- **In:** create new skills; update existing skills (including overriding built-ins via the
  existing user-layer shadowing in `loadLayeredSkills`).
- **Out:** deleting skills (the Skills panel already does that); diff views (the confirmation
  shows the full proposed body, like note proposals).

## Core (`@bean/core`)

### `converse.ts`

- New interface:
  ```ts
  export interface ProposedSkill { name: string; body: string; updating: boolean; }
  ```
  `updating` is true when a skill with that name already exists in the loaded skills list
  (user or built-in). Added to `ConverseResult` as `proposedSkill?`.
- New `propose_skill` tool spec, offered on **every** `converse()` call (it needs no terminal,
  so chatops gets it too). Parameters: `name` (kebab-case, becomes the filename) and `body`
  (full markdown, with `description:` frontmatter; `target: chat` optional). The tool
  description instructs the model on both.
- `converse()` validates `name` with the same traversal rule as `saveSkill`
  (`/[/\\]|\.\./` rejected — the tool call is treated as malformed and ignored/reported back
  to the model) and computes `updating` by comparing against the skills passed in.

### Built-in skill: `.bean/skills/generate-skill.md`

`target: chat` skill teaching the model how to author Bean skills: frontmatter conventions
(`description:`, `target: chat` vs terminal skills, `enabled:`), what makes a good router-visible
description, body structure, and an instruction to finish by calling `propose_skill` with the
complete draft.

### Chatops (`chatops/`)

- `proposals.ts`: new `SkillProposalStore` mirroring `NoteProposalStore` (10-min expiry,
  one-shot `claim()` so two members can't double-save).
- `cards-api.ts`: `skillProposalCard` (name, "updates existing skill" badge when `updating`,
  full body, Save/Cancel) and `skillResultCard` (saved/cancelled) added to `CardBuilders`.
- `bot.ts`:
  - New dep: `saveSkill: (name: string, body: string) => Promise<void>` (server injects the
    user's `~/.bean/skills` dir) and `skillProposals: SkillProposalStore`.
  - `onMessage`: when `result.proposedSkill` is set, add to the store, post the proposal card,
    record the card activity id — same shape as the note flow.
  - `onCardAction`: handle `save-skill` / `cancel-skill` — claim, save via `deps.saveSkill`,
    update the card to the result state, post a confirmation or error message.

## App (`@bean/app`)

- ChatWindow renders `proposedSkill` as a ProposalCard variant: skill name, badge when
  `updating`, full markdown body, Save/Cancel. Confirm calls the existing
  `window.bean.saveSkill()` preload bridge → `buildSaveSkillHandler` → core `saveSkill()`.
  **No new IPC channels.**
- `chat-types.ts` / `bean.d.ts` updated only as needed to carry `proposedSkill` through
  the existing chat result type.

## Servers (`@bean/discord`, `@bean/teams`)

- Construct and pass `SkillProposalStore` and a `saveSkill` bound to
  `skillsDir(beanDir())`.
- Implement the two new cards in each platform's card builder (Discord components,
  Teams adaptive cards) and route the `save-skill`/`cancel-skill` action ids through
  the existing card-action dispatch.

## Error handling

- Save failure → error message in-channel (same pattern as notes); the proposal is consumed
  (claimed), so the user re-asks.
- Expired proposal → "that skill draft expired — ask me again."
- Invalid name from the model → tool result tells the model the name is invalid; no proposal
  is surfaced.

## Testing

- `converse.test.ts`: `propose_skill` call → `proposedSkill` on the result; `updating` computed
  correctly; traversal names rejected.
- `chatops-proposals.test.ts`: `SkillProposalStore` add/claim/expiry (mirror existing store tests).
- `chatops-bot.test.ts`: proposedSkill → card posted; `save-skill` action → `saveSkill` called
  and result card updated; cancel and expired paths.
- App-side: ProposalCard variant covered by existing component test conventions if present.

## Validation gate

`pnpm test && pnpm typecheck` must pass. Chatops servers are spawned subprocesses — per
AGENTS.md, smoke-check the built server path if the wiring changes touch spawn/env behavior
(this change only adds deps inside the bots, so unit coverage plus build should suffice).
