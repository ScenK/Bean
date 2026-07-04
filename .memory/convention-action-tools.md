# Action tools vs propose_run

`converse()` (core) now takes an optional `actions: ActionTool[]` — tools Bean executes
itself in the Electron main process (first ones: `set_reminder`/`list_reminders` over
`~/.bean/reminders.json`, wired in `app/src/main.ts`). They differ from `propose_run`:

- **propose_run** is confirm-first: it short-circuits out of `converse()` as a
  `proposedRun` and renders as a ProposalCard; the user confirms before anything runs.
- **Action tools** run immediately inside `converse()`'s tool loop (max 3 rounds); the
  result string is fed back to the model, which confirms in text. No IPC/preload change
  needed — they ride the existing `bean:chat` flow.

**Chat-target skills** build on this: a skill with `target: chat` frontmatter runs in Bean's
own chat instead of the terminal. `Skill.target` → copied onto `RouteSuggestion.target` by
`converse()`/`planForDroppedSkill()` → both confirm sites branch on it (ChatWindow's
`confirmProposal` sends the prompt into the same conversation; PlanWindow calls
`window.bean.runInChat`, which stores the prompt in `buildChatPromptStore()` — same
pull-on-mount race fix as the plan/dropped-url stores — and opens the chat). The transcript
shows a collapsed `▶ <skill>` label (`ChatItem.display`) while the model gets the full
prompt. `fetch_url` (main.ts, backed by core's pure `extractPageText()`) is the action tool
that lets chat-target skills actually read dropped URLs. Built-in content skills
(summarize/explain/draft-reply/extract-tasks in repo `.bean/skills/`) are chat-target;
`builtin-skills.test.ts` enumerates them, so adding a built-in means updating that test.

Tool results are appended as user-role messages (`[tool result for X]: …`), not the
OpenAI `tool_call_id` protocol — deliberate shortcut; switch to real tool messages if
models start re-calling tools. Reminders fire from a 30s poll in `main.ts` via Electron
`Notification`; the store mirrors `memory-store.ts`. New helper capabilities (notes,
routines) should follow this ActionTool shape, keeping IO pure/DI in core.
