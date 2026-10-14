# Headless household Bean (container)

Bean's Discord bot runs your household's chat, reminders and scheduled routines in a Linux
container, with no desktop app. The recipe is the repo-root `Dockerfile`. This page is the owner's
setup checklist.

## What the image does

- Builds `@bean/core` and `@bean/discord` only. The Electron app is not in the image.
- Runs as the non-root `node` user, under `tini` as PID 1.
- Sets `HOME=/data`, which is the volume. `~/.bean`, the CLI logins and their MCP config all
  live there.
- Sets a fixed `PATH`. The bot finds CLIs on `PATH` only; there is no login-shell probe.
- Installs the `claude` and `codex` CLIs.
- Sets `BEAN_HEADLESS_ROUTINES=1`, so this process runs the routine scheduler and reminders.
- Mounts no Docker socket and no personal directories. Keep it that way.

```bash
docker build -t bean-household .
docker volume create bean-household
docker run -d --name bean --restart unless-stopped \
  -v bean-household:/data \
  -e TZ=America/Toronto \
  -e CLAUDE_CODE_OAUTH_TOKEN \
  bean-household
docker logs -f bean
```

Run one container per volume. Never point the desktop app at this volume: two schedulers on one
`~/.bean` fire every routine twice.

## Owner checklist

Write files into the volume with `docker exec -it bean sh` (or a throwaway container on the same
volume before first start). Every path below is inside the container.

1. **`TZ` (required).** Cron routines and reminders run in local time. Without `TZ` the bot exits
   at boot:
   `bean: BEAN_HEADLESS_ROUTINES=1 needs TZ set (e.g. TZ=America/Toronto) — cron routines fire in local time.`

2. **`/data/.bean/config.json`** with the OpenAI API key:
   `{ "openaiApiKey": "sk-..." }` (`model` defaults to `gpt-4o-mini`).
   Bean's own chat always uses this key. The Claude/Codex subscription login covers delegates
   only. Boot errors: `Bean config missing: /data/.bean/config.json`, or
   `openaiApiKey missing in ~/.bean/config.json`.

3. **`/data/.bean/discord.json`**: bot token, owner, and household members.
   `{ "botToken": "...", "ownerId": "<your id>", "ownerName": "<your name>", "memberIds": ["<id>", "<id>"] }`.
   Bot setup (intents, invite scopes) is in `packages/discord/README.md`. The file is read at
   startup only: **restart the container after changing it** (`docker restart bean`). Boot error
   when it is missing: `Discord config missing: /data/.bean/discord.json — …`.

4. **Headless routines switch.** The image sets `BEAN_HEADLESS_ROUTINES=1`. Leave it on. Notices
   that are desktop notifications on a Mac (a failing watch, `notify` sinks, routines missed
   while the bot was down) arrive as DMs to `ownerId`. Missed routines do not catch up.

5. **Household delegate login.** Use a separate household subscription account, never your
   personal login.
   - Claude: on any machine, run `claude setup-token` while logged in as the household account.
     Pass the token as the `CLAUDE_CODE_OAUTH_TOKEN` secret (`-e` from your shell, or a
     compose/orchestrator secret). Never write it into an image or a committed file.
   - Codex: `docker exec -it bean codex login --device-auth`. The login lands in
     `CODEX_HOME=/data/.codex`, on the volume, so it survives restarts.
   - Check: the boot line reports each CLI's auth, for example
     `@bean/discord headless routines on: TZ=America/Toronto, clis: claude, codex (auth claude=yes codex=no), 0 routine(s) (0 enabled), owner 111`.

6. **Household-only MCPs.** Add only MCP servers meant for the household, in the container's
   CLI config (on the volume):
   - Claude: `docker exec -it bean claude mcp add --scope user <name> -- <command>` (writes
     `/data/.claude.json`).
   - Codex: `[mcp_servers.<name>]` tables in `/data/.codex/config.toml`.

7. **Back up `bean.db`.** It holds memories, notes, chat history and run logs. It is in WAL
   mode, so do not copy the file alone while the bot runs. Take a consistent snapshot instead:

   ```bash
   docker exec bean node -e 'new (require("node:sqlite").DatabaseSync)("/data/.bean/bean.db").exec("VACUUM INTO \x27/data/bean-backup.db\x27")'
   docker cp bean:/data/bean-backup.db ./bean-backup-$(date +%F).db
   docker exec bean rm /data/bean-backup.db
   ```

   Back up `/data/.bean/routines/` and the config files too, or snapshot the whole volume.

8. **Member onboarding.**
   1. The new member DMs the bot `whoami`. Bean replies with their Discord id, even before they
      are added.
   2. Add that id to `memberIds` in `discord.json`.
   3. Restart the container.

   Members get memory, notes, todos and reminders, DMs included. Each member has a daily turn
   cap (200); over the cap, Bean refuses the turn. Members get no delegates, live sessions,
   skills or Mac control.

## Accepted risk

Delegates run with permissions skipped, so a delegate can read anything on the volume:
`config.json` (the OpenAI key), `discord.json` (the bot token), `bean.db` (every member's private
memories) and the CLI logins. Bean passes only an allowlisted environment to spawned CLIs, but
the files are still readable. This is why delegates, live sessions and skills stay owner-only.
It is also why the delegate login is a separate household account and the container mounts
nothing personal.

## Lifecycle

- `docker stop` sends SIGTERM. The bot stops the scheduler, lets pending state writes land
  (5 s cap), and kills running delegates and command steps. The default 10 s stop timeout is
  enough.
- On boot, run reservations left in `/data/.bean/runs/` are killed and cleared, and the owner
  gets one DM listing them.
