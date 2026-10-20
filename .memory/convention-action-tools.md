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
(`bean`, `generate-skill` in repo `.bean/skills/`) are chat-target;
`builtin-skills.test.ts` enumerates them, so adding a built-in means updating that test.

Tool results use the OpenAI `tool_call_id` protocol: `converse()` preserves the assistant
tool-call turn, appends one `role: "tool"` result per executed action, and
`openai-chat.ts` translates Bean's camelCase internal shape to OpenAI's snake_case API
shape. Reminders fire from a 30s poll (`fireDueReminders`) in `main.ts` — or in the headless
Discord host — via Electron `Notification`.

**Chatops reminders (#282).** Discord members+ get `set_reminder`/`list_reminders`/
`cancel_reminder` (`chatops/reminder-tools.ts`); the receipt's Cancel button carries the id.
`Reminder.target` (DM → `userId`, channel → `channelId`) and `setBy` are stamped from the
ingress, never model args; non-owners list/cancel only their own. Targeted reminders go out
via the outbox; a malformed target fails loudly (never the owner's DM). Teams targets are
always `{ transport: "teams", channelId: <full ingress conversation id> }` — its outbox
ignores `userId` (#343). Outside a DM, `list_reminders` shows only this conversation's
reminders (same transport + bare id, `id.split(";")[0]`, so Teams sibling threads match),
and cancel (tool or card) echoes the text only into its own conversation — the owner's
authority is global, its visibility isn't. **Every write goes through `updateReminders`** (in-process chain +
`reminders.json.lock` O_EXCL lock, since the desktop loop and its spawned bot share the file);
`claimDueReminders` marks fired *before* delivery — never go back to bare load/save. New helper capabilities (notes, routines) should follow this
ActionTool shape, keeping IO pure/DI in core.

**Web search is not an ActionTool.** It's the provider's built-in tool, passed as
`webSearch: true` on `ConverseDeps["chat"]` (not in `tools: ToolSpec[]`) and appended as
`{ type: "web_search" }` by `openai-chat.ts`. OpenAI runs it inside the same response, so
there's no round in `converse()`'s tool loop; the adapter drops `web_search_call` output
items like reasoning items. Gated by config `webSearch` on desktop/Discord/Teams (bots read
config at startup — restart to apply) and by the per-routine `webSearch` flag for routine
chat steps (never the digest call).
