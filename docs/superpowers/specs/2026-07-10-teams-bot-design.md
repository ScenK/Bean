# Bean Teams Bot (`@bean/teams`) — Design

**Date:** 2026-07-10
**Status:** Approved (brainstorm with skang)
**Scope:** POC for a 3-person corporate Teams group chat

## Goal

Let a small group @mention Bean in a Microsoft Teams group chat. Bean chats using its
existing brain (`converse()` with persona, skills, projects, memories from `~/.bean`) and can
run confirm-first **delegate runs** (headless `claude -p` / `opencode run`) on the owner's
Mac, posting the result back to the thread. All logic runs locally; only a tunnel and the
Azure Bot registration live outside the machine.

Decisions made during brainstorming:

- **Approach:** real Teams bot (Azure Bot Service + custom app manifest), not an outgoing
  webhook or Power Automate bridge. IT approval for the POC is attainable.
- **Capability:** chat + delegate runs. Terminal launches (`propose_run`) and notes
  (`propose_note`) are desktop-only and politely declined in Teams.
- **Authorization:** anyone in the group chat may confirm a proposed run. The confirm card
  shows the verbatim instruction and records who confirmed.
- **CLI/model:** selectable in chat text ("use opencode with GPT-5.5"), adjustable on the
  proposal card, automatic defaults when unstated.

## Architecture

```
Teams group chat ──@Bean──▸ Azure Bot Service ──HTTPS──▸ dev tunnel ──▸ localhost:3978
                                                                        @bean/teams server
                                                                          ├─ converse()      (@bean/core)
                                                                          ├─ runDelegate()   (@bean/core)
                                                                          └─ ~/.bean config, skills, projects, persona, memories
```

A third workspace package, `packages/teams/` (`@bean/teams`): a plain Node HTTP server
(Express + `botbuilder`), zero Electron. It follows the repo's layering rule — everything
testable is a pure, dependency-injected function; a thin `server.ts` does the impure wiring
(the `main.ts`/`ipc.ts` split, mirrored).

The bot's HTTPS endpoint is exposed from the owner's Mac via a Microsoft **dev tunnel**
(`devtunnel host -p 3978 --allow-anonymous`); Bot Framework JWT validation on
`/api/messages` is the real access gate, not the tunnel URL.

## Package layout

```
packages/teams/
  src/
    server.ts        # wiring only: config load, CloudAdapter, Express, start
    bot.ts           # buildTeamsBot(deps) — pure handler factory (ipc.ts analogue)
    conversation.ts  # per-thread ChatTurn[] history (in-memory, capped ~20 turns)
    proposals.ts     # pending proposal store: id → proposal + conversation ref (10 min expiry)
    cards.ts         # Adaptive Card builders: proposal, progress, result, error
    runs.ts          # active DelegateHandle registry; one run per project path
  __test__/          # vitest, core-style DI tests
```

`bot.ts` takes `deps` (chat fn, `runDelegate`, loaders, config) so tests inject fakes without
mocking Bot Framework.

## Message flow (chat)

On `@Bean <text>`:

1. Strip the mention; map the Teams conversation id to an in-memory history buffer
   (restart = amnesia; acceptable for the POC).
2. Reload skills/projects/persona/memories via the existing core loaders (per-message, same
   as `buildChatHandler`) and call `converse(...)` with `delegateAvailable = true`.
3. Post `result.reply` in-thread.
4. `proposedRun` / `proposedNote` → reply "that needs the desktop app". Only
   `proposedDelegate` is honored.

Skills are the owner's local `~/.bean/skills/*.md`, loaded by core's `skill-library.ts`;
editing a skill file takes effect on the next @mention.

## Delegate confirm flow

When `converse()` returns `proposedDelegate`:

1. Generate a proposal id; store `{ proposal, conversationRef, proposedBy }` with a
   10-minute expiry.
2. Post an Adaptive Card: project name, optional skill, **verbatim instruction**, CLI and
   model `Input.ChoiceSet` dropdowns (pre-selected per the resolution rules below), and
   **Run** / **Cancel** buttons.
3. Any member taps Run. The card is edited in place to "Running… (started by *name*)" —
   single-use buttons, no double launch.
4. `runDelegate()` spawns the CLI in the project dir. `onOutput` tail lines are throttled
   into card edits (~5 s cadence; Teams rate-limits edits). `onDone` posts the final result
   to the thread **and appends it to the conversation history** so follow-ups can discuss
   it. `onError`/timeout post the error.
5. Concurrency: one active run per project path; a second confirm gets "already running in
   this project". A Cancel button on the running card (or `@Bean cancel`) calls
   `handle.cancel()`.

## CLI/model selection

Three layers, using core's existing `detectClis` / `availableModels` / `pickModel` /
`resolveModelAlias` / model-memory helpers:

1. **Chat-stated (small core change).** `proposeDelegateTool` in `converse.ts` gains two
   optional enum params — `cli` (from detected CLIs, passed into `converse()` as a new
   optional parameter) and `model` (from `MODELS` ids). `ProposedDelegate` gains optional
   `cli`/`model` fields. Backward-compatible; the desktop ignores them for now.
2. **Card override.** The proposal card's ChoiceSets let anyone adjust before Run.
3. **Automatic default.**
   `cli = stated → last-used (model memory) → first of detectClis() → error card if none`;
   `model = pickModel(availableModels(clis), cli, statedModel, lastUsedForCli)`.
   `pickModel` guards cross-CLI mismatches. Confirmed runs update the model memory file.

Server-side validation on confirm re-checks `cli ∈ detectClis()` and the model via
`resolveModelAlias` — card inputs and LLM tool outputs are both untrusted.

## Config & credentials

- `~/.bean/teams.json` → `{ "botAppId", "botAppPassword", "port" (default 3978) }`, loaded by
  a pure `loadTeamsConfig(path)`; missing file throws with a setup hint (matches `config.ts`
  conventions: only missing config throws).
- Everything else reuses the existing `~/.bean` loaders from core — same persona and skills
  in Teams as on the desktop.
- Run: `pnpm --filter @bean/teams start`.

## Security posture (for the IT/POC writeup)

- Every request to `/api/messages` is JWT-authenticated as Bot Framework traffic
  (`CloudAdapter`); a leaked tunnel URL grants nothing.
- Delegate runs are constrained to registered project paths (enum-constrained in the tool
  schema, re-validated server-side against `projects.json`).
- The confirm card shows the verbatim instruction; the group is 3 trusted people; the card
  records who confirmed.
- Plainly stated: **a confirmed run executes a coding agent with shell access
  (`--allowedTools Bash,Edit,Write,Read,Glob,Grep`) on the owner's Mac.** That is the
  feature; it is not buried.

## Error handling

The bot never crashes a turn. `converse()` failure → apologetic reply with the error class.
Delegate error/timeout → posted to the thread. Expired/unknown proposal id on a card action →
"this proposal expired, ask me again". Config problems → fail fast at startup with a clear
message.

## Testing

- Pure units under vitest with injected fakes (same pattern as `core/__test__/delegate.test.ts`):
  `bot.ts` activity→request mapping and proposal handling, `proposals.ts` expiry/single-use,
  `cards.ts` shapes, `runs.ts` concurrency, CLI/model resolution.
- Core change (`proposeDelegateTool` params, `ProposedDelegate` fields) covered in
  `core/__test__/converse.test.ts`.
- No Teams e2e in CI; a `docs/` runbook covers manual verification (tunnel up → @mention →
  confirm → result lands).
- Gate: `pnpm test && pnpm typecheck` green across all three packages.

## Out of scope (POC)

- Persistent conversation/proposal state across restarts.
- `propose_run` (terminal launches) and `propose_note` from Teams.
- Memory extraction from Teams conversations.
- Multi-tenant / multi-owner support; the bot serves one Mac.
