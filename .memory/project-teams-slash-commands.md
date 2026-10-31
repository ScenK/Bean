# Teams slash commands (#359)

Bean's keyword commands appear in Teams' native `/` picker via the manifest's
`bots[0].commandLists` (`triggers: ["slash","mention"]`, `supportsTargetedMessages: true`,
manifest schema ≥ 1.29). The menu lives **in the manifest**: any menu change = `version` bump +
re-upload + (corporate) tenant approval, so batch menu changes; ship behavior bot-side first,
typed (`@Bean foo`) until a menu entry lands. Limits: 3 lists × 12 commands.

A pick arrives as a *targeted message*: `activity.recipient.isTargeted === true`, no @mention
entity (botbuilder 4.23's `ChannelAccount` has no such field — runtime check). `addressing.ts`
`addressedToBot()` counts it as addressed only when strictly `true` and the recipient is the bot
(`28:<appId>`). Addressed = a turn, **never a permission**: `direct` stays the real conversation
type, scope/roles unchanged, so a targeted channel message still recalls shared memories only.
Without this gate a private pick fell into the shared ambient store and replayed publicly.
Replies stay public by decision (no targeted-reply path).

A pick's conversation ref is stored like any other (first-seen wins, `bot.isTargeted: true`) and
can be `personal` for the owner even in a shared chat. Owner-DM selection (`ownerDmRefs`, core
`watch-io.ts`, shared by the Teams outbox and the editor's recipient count) skips targeted refs —
otherwise every DM-sink digest also posted into that shared chat (#549). A real 1:1 is never targeted.

Bumping `manifestVersion` can remove fields, not just add them: the schema sets
`additionalProperties: false`, and 1.30 dropped `packageName`. Teams then rejects the upload
("Property "packageName" has not been defined"). Validate the filled manifest against the new
`$schema` (draft-04 — use `ajv-draft-04`) before zipping.
Teams also enforces rules the schema can't express: ≥ 1.25 with the `team` scope must declare
`supportsChannelFeatures` (only `"tier1"` validates = works in private/shared channels too).
The schema passing doesn't mean the upload will; the upload is the real check.

The command list itself lives in core's `CHATOPS_COMMANDS` (`chatops/commands.ts`); a test fails
if its names drift from the manifest's `commandLists`. Surfaces that invoke a command directly
(a slash menu) call `bot.onCommand(msg, fx)` — never re-implement a command surface-side (Discord's
old `/new` did and skipped the reset bump that keeps a late delegate from restoring its session).
Discord registers the whole catalog (`packages/discord/src/slash.ts`, live-session unconditionally)
and answers every pick through `onCommand`: replies are collected into the ephemeral interaction
reply; `announce` (a real admin change) is the one public post, with `allowedMentions: { parse: [] }`.

Upload state (2026-10-23, sprouts rename #370): repo manifest is `1.3.0`, tenant still on `1.2.0`;
upload deferred to the next batched menu change. Until then the live Teams menu entry says
`routines` (still works via the parser alias) while the reply says sprouts — expected seam. When the
next menu change ships, upload once and reuse `1.3.0` unless that change bumped it.
