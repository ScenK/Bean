# safety: chatops propose_run is chat-target-only

`propose_run` for a terminal skill launches Terminal.app — which doesn't exist in
Discord/Teams; `bot.ts` used to answer any `proposedRun` with a "needs the desktop app"
dead end. Which tool the model picked was phrasing-dependent ("run X" → propose_run,
"investigate X" → propose_delegate), so the same skill silently worked or failed by wording.

The fix (2026-07): `converse()` takes a `runAvailable` flag (default `true`, desktop
unchanged). When `false` (chatops), propose_run is offered — and validated — only for
`target: chat` skills, which the bot then executes on Bean's own model by resending the
composed prompt through the same conversation (mirroring ChatWindow's `confirmProposal`,
no confirm card, no delegate CLI). Terminal-target skills are excluded from the tool's
enum entirely; run/launch phrasing routes to `propose_delegate` via the behavior
instructions. A stray terminal-skill propose_run is dropped by converse's validation.

**Don't re-add terminal skills to chatops propose_run** unless the bots grow a real
handler; the `DESKTOP_ONLY` branch left in `bot.ts` is an unreachable backstop.
