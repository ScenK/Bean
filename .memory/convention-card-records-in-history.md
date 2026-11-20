# convention — confirm cards leave a record line in the model's history (#941)

Every confirm-first card (run, delegate, note, note archive, skill, todo, sprout, send, sprout draft,
live session) is in the model's history as one code-built assistant line,
`[card: <kind> "<name>" — <state>]` (core `card-record.ts`, node-free subpath
`@bean/core/card-record`). Without it a follow-up after a card ("tell me when it's done") re-proposed
the same action, because a tool-only turn leaves no reply text.

- **Desktop:** `chatTurns()` (agent-mode.ts) maps each card item to its line from the item's
  *current* state — not emitted with `memory: true`, and `handoffItems()` never carries them. A
  sprout/todo `done` splits by its settled outcome line (finished / needs attention / failed /
  interrupted / checked / didn't start / unknown) — keep `runEndState` in step with
  `sproutResultLine`/`sproutFinishText` wording.
- **Chatops (`bot.ts` `recordCard`):** one append after each card post and one per authorized
  outcome, before the card edit is awaited; nothing for a tap refused before the claim;
  desk-moved live sessions (`p.id === "desk"`) have no card, so no line. `failed` means the action
  itself failed — once the save/queue/send committed, a failed card edit or receipt post never
  records `failed` (a flag set right after the action). `expired` only via `recordExpired`: the
  store's raw `peek` still held the proposal for this conversation before the empty claim — a
  replayed, forged or other-conversation id records nothing. A refusal before a picked skill
  resolves records no name. A delegate's
  finish record stays the existing `[delegate result]` line; a sprout/todo run's is the dispatch
  notice context (#920).
- **Never in a line:** note title/body, todo text, send body/destination, instructions, paths,
  result/error text, who tapped — only kind, state and a clipped catalog name.
- Lines are assistant-role (never system, never tool specs — the `propose_sprout_run` sentence that
  explains them is static) and not citable for memory. The synced view shows them as status rows.
- Untapped chatops cards stay `pending` after their store's 10-minute expiry (known limit).
- **Lead-in (#978):** every card arrives under one sentence of speech. `converse()`'s behavior
  instructions ask for it (not `AGENT_RULES` — that reaches routine steps and briefs too; with no
  chatops, propose_run is excluded since chat skills run in-line there; keyed on `liveSessionHost`,
  not `runAvailable` — a remote desktop client has no terminal but still shows the card); its proposal returns
  (`card()`) fill `CARD_LEAD` (node-free `@bean/core/card-record`) when the model said nothing.
  Card paths that skip `converse()` add it themselves: desktop `/skill` (`runTerminalSkill`, a
  reply row), the Plan window (Run skill / URL dropped on a skill tile), chatops `/live-session` and Continue live (`fx.post`). Chatops drops the lead for a
  chat-target run (no card follows) and for an ignored nested card's second hop. A new
  converse-free card path needs the same.
