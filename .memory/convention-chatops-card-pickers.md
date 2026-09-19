# Chatops card pickers — recompose at launch, respect Discord's select caps

Two rules every on-card picker (skill / project / model / cli) on a Discord or Teams
proposal card has to follow. Both were real bugs, not hypotheticals.

**1. Anything a picker can change must be re-derived at launch, never read from a value
converse() precomputed.** `ProposedDelegate.composedPrompt` is composed once, at propose
time, from the skill the model guessed. The delegate card's skill picker can change that
skill minutes later, so `startRun` (`core/src/chatops/bot.ts`) re-runs
`composePrompt(skill, instruction)` instead — same thing `startLiveSessionAction` already
did. If you add a picker for something folded into a precomputed string, move the
composition to the launch site too, or the card and the run silently disagree.

Corollary: a named-but-unresolvable skill (deleted/renamed while the 10-minute proposal sat,
or a bogus submitted value) **refuses the run**. Falling back to the bare instruction would
launch something other than what the card showed.

**2. Discord string selects: ≤ 25 options, and each option `value` ≤ 100 chars.** An
over-long value rejects the whole component payload, so the card never posts. With a sentinel
option (`__none__` for "no skill") only 24 real entries fit, and the *picked* entry must be
hoisted to the front — otherwise truncation drops the option the card is defaulting to, the
select renders with nothing selected, and pressing Run still uses the original pick. One
`skillSelectRows()` in `discord/src/components.ts` serves both the delegate and live-session
cards; a new picker should reuse or mirror it rather than re-slicing inline. Teams'
Adaptive Card `Input.ChoiceSet` has no such caps — the limits are Discord's alone.

Teams merges every `Input.*` value into the Run/Start submit, so its handler sees the picks
unconditionally; Discord applies selects live into a per-message `selections` map
(`discord/src/server.ts`) and only sends the ones the user actually touched. Guards in
`onCardAction` must therefore be no-ops when a field is absent.

Related: [project-live-sessions.md](project-live-sessions.md),
[project-config-driven-cli-models.md](project-config-driven-cli-models.md).
