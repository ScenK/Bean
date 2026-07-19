# @bean/discord — Bean in your DMs and personal server (POC)

Personal single-user Discord adapter over the same chatops brain as `@bean/teams`
(`packages/core/src/chatops/`). Gateway (outbound WebSocket) — no tunnel, no public
endpoint. Design: `docs/superpowers/specs/2026-07-10-discord-adapter-design.md`.

## One-time setup

1. **Create the bot**: discord.com/developers → New Application → Bot. Copy the **bot token**.
   Under *Privileged Gateway Intents*, enable **Message Content Intent**.
2. **Invite it**: OAuth2 → URL Generator → scopes `bot` **and `applications.commands`**
   (the second is required for slash commands to register — without it Bean's `/` menu stays
   empty) → permissions: View Channels, Send Messages, Read Message History → open the URL,
   add to your private server.
3. **Your user id**: Discord settings → Advanced → enable Developer Mode, then right-click
   your name → "Copy User ID".
4. **Config**: create `~/.bean/discord.json`:
   `{ "botToken": "<token>", "allowedUserIds": ["<your user id>"] }`
   Optional `"guildId": "<server id>"` registers slash commands to that one server instantly;
   without it they register globally (every server Bean is in, but ~1h first propagation).

## Run

    pnpm build
    pnpm --filter @bean/discord start

@mention the bot in a server channel, reply to one of its messages, or DM it (no mention
needed in DMs). Merely naming it ("we should add x to bean") is deliberately not an address —
that message is kept as ambient context, not answered. Only allowlisted user ids get
responses; everyone else is silently ignored. Saying a CLI/model in the message ("with
opencode on GPT-5.5") is honored; delegate runs are confirm-first via buttons and execute on
THIS machine.

Slash commands (Discord `/` menu): `/new` (clear this conversation's context), `/cancel`
(stop in-flight runs), `/stop` (end the channel's live session), and — when live sessions are
enabled — `/live-session <prompt>`. The same words also work as plain text (`cancel`, `stop`,
`/new`, `/live-session …`), so an `@bean /live-session …` message routes the same as the slash
command (verbatim, not reworded by the model).

## Manual verification checklist

- [ ] Server logs "logged in as …" with detected CLIs.
- [ ] An untagged message naming the bot ("bean is slow today") → no reply at all.
- [ ] `@bean /new` → "Fresh start"; a follow-up shows no memory of the prior chat.
- [ ] DM hello → reply (no mention needed).
- [ ] Guild @mention hello → reply; un-mentioned guild message → ignored.
- [ ] Message from a non-allowlisted account → ignored (messages and buttons).
- [ ] "summarize the bean repo" → proposal embed with CLI/model selects + Run/Cancel.
- [ ] Changing a select then Run → run starts with the chosen cli/model.
- [ ] Running embed updates with tail lines; result posts when done (chunked if >2000 chars).
- [ ] Second confirm while the project is busy → polite refusal.
- [ ] Cancel run → embed flips to cancelled. Text "cancel" also cancels.
- [ ] Proposal older than 10 min → "expired" on Run.
