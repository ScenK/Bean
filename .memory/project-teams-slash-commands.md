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

A `// TEMP:` stdout log in `server.ts` dumps targeted payloads (recipient, entity types/ids, 40
chars of text) for the dev-tenant check — remove it once confirmed. If it shows no mention
entity, `add-admin`/`remove-admin` picks can't carry the target; mark them typed-only.

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
