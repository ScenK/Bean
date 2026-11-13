# Headless Bean (`bean-core`)

`bean-core` is Bean with no desktop app: the sprout scheduler and reminders, plus the Discord and
Teams bots. It runs natively as a service (launchd on macOS, systemd on Linux) or in a Linux
container. This page is the owner's setup checklist.

## What `bean-core` does

- Runs the host (`@bean/host`, `packages/host/dist/bean-core.js`) under plain Node. No Electron.
- Starts the Discord bot when `~/.bean/discord.json` exists and the Teams bot when
  `~/.bean/teams.json` exists. Neither is required. With no bot, it still runs sprouts and
  reminders.
- Holds the scheduler lease in `bean.db`. One data directory runs one scheduler. A second
  `bean-core` (or the desktop app) on the same `~/.bean` stands by and logs
  `bean-core: Sprouts failed: Sprouts and reminders paused: another Bean is scheduling — …`. It
  takes over when the holder stops, or ~90 s after the holder crashes.
- Sends desktop notices (reminders without a chat target, `notify` sinks, failing watches,
  sprouts missed while it was down) to the owner's DM through the first configured bot (Discord,
  then Teams). With no bot, it logs them.
- Finds CLIs (`claude`, `codex`, `opencode`) through the login shell's `PATH`, as the desktop app
  does, because a service gets a minimal `PATH`.
- Logs one boot line, for example
  `bean-core on: TZ=America/Toronto, data /data/.bean, clis: claude, codex (auth claude=yes codex=no), 2 sprout(s) (1 enabled), bots: discord, scheduler on`.

## Native service (a core used for coding)

Use this when the core runs on the machine that has your projects, toolchains, SSH keys and CLI
logins. Build once from the checkout: `pnpm install && pnpm build`. The entry is
`<checkout>/packages/host/dist/bean-core.js`. Rebuild after `git pull`, then restart the service.

### macOS (launchd)

Save as `~/Library/LaunchAgents/dev.bean.core.plist`. Replace the node path (`which node`), the
checkout path, the user name and the time zone:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.bean.core</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/you/Bean/packages/host/dist/bean-core.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>TZ</key><string>America/Toronto</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/bean-core.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/bean-core.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.bean.core.plist
launchctl kickstart -k gui/$(id -u)/dev.bean.core   # restart after a rebuild
launchctl bootout gui/$(id -u)/dev.bean.core        # stop and unload
```

A LaunchAgent starts at login. To keep Bean running across a reboot with nobody at the screen,
turn on automatic login for that account. Do not run the desktop app on the same `~/.bean`: it
stands by while `bean-core` holds the lease.

### Linux (systemd)

Save as `/etc/systemd/system/bean-core.service`. Replace the user, node path, checkout path and
time zone:

```ini
[Unit]
Description=Bean core (sprouts, reminders, chat bots)
After=network-online.target
Wants=network-online.target

[Service]
User=you
WorkingDirectory=/home/you
Environment=TZ=America/Toronto
ExecStart=/usr/bin/node /home/you/Bean/packages/host/dist/bean-core.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bean-core
journalctl -u bean-core -f
```

If `node` comes from nvm, point `ExecStart` at that node binary
(`~/.nvm/versions/node/<version>/bin/node`). The CLIs it finds come from the user's login shell.

## Container

The recipe is the repo-root `Dockerfile`.

- Builds `@bean/core`, `@bean/host` and both bot servers. The Electron app is not in the image.
- Runs `bean-core` as the non-root `node` user, under `tini` as PID 1.
- Sets `HOME=/data`, which is the volume. `~/.bean`, the CLI logins and their MCP config all
  live there.
- Installs the `claude` and `codex` CLIs.
- Exposes port 3978 for the Teams bot. Discord needs no inbound port.
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

Run one container per volume.

**Teams in the container.** Microsoft's Bot Service must reach the bot's messaging endpoint. Either
publish the port (`-p 3978:3978`) behind your own HTTPS reverse proxy and set the Azure Bot
messaging endpoint to `https://<your-host>/api/messages`, or run `devtunnel host -p 3978` on the
Docker host and use its URL plus `/api/messages`. The image does not include `devtunnel`, so the
`"devtunnel"` key in `teams.json` does not work inside the container.

## Owner checklist

In the container, write files into the volume with `docker exec -it bean sh` (or a throwaway
container on the same volume before first start); `~/.bean` is `/data/.bean` there. Natively,
`~/.bean` is the service user's.

1. **`TZ` (required).** Cron sprouts and reminders run in local time. Without `TZ`, `bean-core`
   exits at boot:
   `bean-core: needs TZ set (e.g. TZ=America/Toronto) — cron sprouts and reminders fire in local time.`

2. **`~/.bean/config.json`** with the OpenAI API key:
   `{ "openaiApiKey": "sk-..." }` (`model` defaults to `gpt-4o-mini`). This file is the only one
   `bean-core` requires. Bean's own chat always uses this key. The Claude/Codex subscription login
   covers delegates only. Boot error when it is missing:
   `bean-core: no config — create …/.bean/config.json with { "openaiApiKey": "sk-..." }.`

3. **Bots (optional).** Each bot starts only when its file exists. Files are read at startup only:
   **restart `bean-core` after changing one** (`docker restart bean`).
   - `~/.bean/discord.json`: bot token, owner, and members.
     `{ "botToken": "...", "ownerId": "<your id>", "ownerName": "<your name>", "memberIds": ["<id>", "<id>"] }`.
     Bot setup (intents, invite scopes) is in `packages/discord/README.md`.
   - `~/.bean/teams.json`: see `packages/teams/README.md`, and set `ownerId` so notices reach
     your 1:1 chat. DM the bot once first; until then Teams has no conversation to post to.
   A bot that fails to start is logged (`bean-core: discord stopped — …`) and retried twice.

4. **Notices.** Desktop notifications on a Mac (reminders, a failing watch, `notify` sinks,
   sprouts missed while `bean-core` was down) arrive as DMs to the owner of the first configured
   bot, or as log lines with no bot. Missed sprouts do not catch up; they resume at their next slot.

5. **Shared delegate login.** Use a separate, dedicated subscription account, never your
   personal login.
   - Claude: on any machine, run `claude setup-token` while logged in as that dedicated account.
     Pass the token as the `CLAUDE_CODE_OAUTH_TOKEN` secret (`-e` from your shell, or a
     compose/orchestrator secret). Never write it into an image or a committed file.
   - Codex: `docker exec -it bean sh -c 'mkdir -p "$CODEX_HOME" && codex login --device-auth'`. The login lands in
     `CODEX_HOME=/data/.codex`, on the volume, so it survives restarts.
   - Check: the boot line reports each CLI's auth, for example
     `bean-core on: TZ=America/Toronto, data /data/.bean, clis: claude, codex (auth claude=yes codex=no), 0 sprout(s) (0 enabled), bots: discord, scheduler on`.

6. **Shared-only MCPs.** Add only MCP servers meant for everyone who uses this Bean, in the container's
   CLI config (on the volume):
   - Claude: `docker exec -it bean claude mcp add --scope user <name> -- <command>` (writes
     `/data/.claude.json`).
   - Codex: `[mcp_servers.<name>]` tables in `/data/.codex/config.toml`.

7. **Back up `bean.db`.** It holds memories, notes, chat history and run logs. It is in WAL
   mode, so do not copy the file alone while `bean-core` runs. Take a consistent snapshot instead:

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
the files are still readable. This is why members never get delegates, live sessions or
skills. A channel admin (`add-admin`) can run delegates and skills, so on this install grant
admin to no one: keep delegates owner-only. It is also why the delegate login is a separate, dedicated account and the container mounts
nothing personal.

## Lifecycle

- `docker stop` / `systemctl stop` / `launchctl bootout` send SIGTERM. `bean-core` stops the
  scheduler, stops the bots (each marks its in-flight runs interrupted), kills running delegates
  and command steps, releases the lease, and exits.
- If another Bean takes the lease over (this one stalled past its heartbeat), `bean-core` exits
  with code 1. The service manager restarts it, and it stands by.
- On boot, run records left in `~/.bean/runs/` by dead processes are cleared.
