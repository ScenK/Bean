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
