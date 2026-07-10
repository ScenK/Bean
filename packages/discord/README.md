# @bean/discord — Bean in your DMs and personal server (POC)

Personal single-user Discord adapter over the same chatops brain as `@bean/teams`
(`packages/core/src/chatops/`). Gateway (outbound WebSocket) — no tunnel, no public
endpoint. Design: `docs/superpowers/specs/2026-07-10-discord-adapter-design.md`.

## One-time setup

1. **Create the bot**: discord.com/developers → New Application → Bot. Copy the **bot token**.
   Under *Privileged Gateway Intents*, enable **Message Content Intent**.
2. **Invite it**: OAuth2 → URL Generator → scope `bot` → permissions: View Channels,
   Send Messages, Read Message History → open the URL, add to your private server.
3. **Your user id**: Discord settings → Advanced → enable Developer Mode, then right-click
   your name → "Copy User ID".
4. **Config**: create `~/.bean/discord.json`:
   `{ "botToken": "<token>", "allowedUserIds": ["<your user id>"] }`

## Run

    pnpm build
    pnpm --filter @bean/discord start

@mention the bot in a server channel, or DM it (no mention needed in DMs). Only allowlisted
user ids get responses; everyone else is silently ignored. Saying a CLI/model in the message
("with opencode on GPT-5.5") is honored; delegate runs are confirm-first via buttons and
execute on THIS machine.

## Manual verification checklist

- [ ] Server logs "logged in as …" with detected CLIs.
- [ ] DM hello → reply (no mention needed).
- [ ] Guild @mention hello → reply; un-mentioned guild message → ignored.
- [ ] Message from a non-allowlisted account → ignored (messages and buttons).
- [ ] "summarize the bean repo" → proposal embed with CLI/model selects + Run/Cancel.
- [ ] Changing a select then Run → run starts with the chosen cli/model.
- [ ] Running embed updates with tail lines; result posts when done (chunked if >2000 chars).
- [ ] Second confirm while the project is busy → polite refusal.
- [ ] Cancel run → embed flips to cancelled. Text "cancel" also cancels.
- [ ] Proposal older than 10 min → "expired" on Run.
