# @bean/discord — Bean in your DMs and personal server

Personal single-user Discord adapter over the same chatops brain as `@bean/teams`
(`packages/core/src/chatops/`). Gateway (outbound WebSocket) — no tunnel, no public
endpoint. Design: `docs/superpowers/specs/2026-07-10-discord-adapter-design.md`.

## One-time setup

1. **Create the bot**: discord.com/developers → New Application → Bot. Copy the **bot token**.
   Under *Privileged Gateway Intents*, enable **Message Content Intent**.
2. **Invite it**: OAuth2 → URL Generator → scopes `bot` **and `applications.commands`**
   (the second is required for slash commands to register — without it Bean's `/` menu stays
   empty) → permissions: View Channels, Send Messages, Read Message History, Create Public Threads,
   Send Messages in Threads → open the URL,
   add to your private server.
3. **Your user id**: Discord settings → Advanced → enable Developer Mode, then right-click
   your name → "Copy User ID".
4. **Config**: create `~/.bean/discord.json`:
   `{ "botToken": "<token>", "ownerId": "<your user id>", "ownerName": "<your name>" }`
   `ownerId` is the owner (full powers; routine digests with no channel DM them). Everyone else
   is a guest (chat only) unless the owner runs `add-admin @name` in a channel; `admins` and
   `whoami` list roles. `"memberIds": ["<user id>", ...]` makes household members (memory, notes,
   todos — everywhere, DMs included; no delegates, live sessions, skills or Mac control); restart
   to apply. `"allowGuestDms": true` lets guests DM Bean (default off). A legacy
   single-entry `allowedUserIds` is read as `ownerId`; several entries fail startup.
   Optional `"guildId": "<server id>"` registers slash commands to that one server instantly;
   without it they register globally (every server Bean is in, but ~1h first propagation).

## Run

    pnpm build
    pnpm --filter @bean/discord start

@mention the bot in a server channel, reply to one of its messages, or DM it (no mention
needed in DMs). Merely naming it ("we should add x to bean") is deliberately not an address —
that message is kept as ambient context, not answered. Only allowlisted user ids get
responses; everyone else is silently ignored.

Sessions are threads: a top-level @mention in a server text channel opens a thread on that
message (named by the model) and Bean answers inside it. Every message in a Bean-opened thread
is addressed to Bean — no @mention needed — and each thread keeps its own history, so parallel
work is just another top-level @mention. DMs stay a single session. Saying a CLI/model in the message ("with
opencode on GPT-5.5") is honored; delegate runs are confirm-first via buttons and execute on
THIS machine.

Slash commands (Discord `/` menu): `/new` (clear this conversation's context), `/cancel`
(stop in-flight runs), `/stop` (end the channel's live session), and — when live sessions are
enabled — `/live-session <prompt>`. The same words also work as plain text (`cancel`, `stop`,
`/new`, `/live-session …`), so an `@bean /live-session …` message routes the same as the slash
command (verbatim, not reworded by the model).

## Headless routines (no desktop app)

On a bot-only install (e.g. a Linux container) the bot can run your scheduled routines itself:

    TZ=America/Toronto BEAN_HEADLESS_ROUTINES=1 pnpm --filter @bean/discord start

- **Only one scheduler per `~/.bean`.** Never set this where the desktop app also runs against
  the same `~/.bean` — both would fire every routine. The app strips the variable from the bot it
  spawns, so the normal Mac setup is unaffected.
- `TZ` is required (cron matches in local time); the bot exits with one line if it's unset.
- Boot logs the detected CLIs, whether each has auth, the routine count, and the owner id.
- Notices that are desktop notifications on the Mac — a failing watch, `notify` sinks, routines
  missed while the bot was down — arrive as DMs to `ownerId`.
- On boot, run reservations left in `~/.bean/runs/` are killed and cleared (one owner DM if any).
- SIGTERM stops the scheduler, lets pending state writes land, and kills routine children.

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
