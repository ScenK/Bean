# Headless Bean (`bean-core`)

`bean-core` is Bean with no desktop app: the sprout scheduler and reminders, plus the Discord and
Teams bots. It runs natively as a service (launchd on macOS, systemd on Linux) or in a Linux
container. A desktop app on a Mac or a Windows PC can attach to it over SSH. This page is the
owner's setup checklist: pick a core, run it, then (optionally) attach a shell.

## Which core to run

- **Native, on a development machine — for coding.** Delegates and live sessions run on the core's
  machine, so they need that machine's projects, toolchains, SSH keys and CLI logins. Run the core
  natively where that work lives ([Native service](#native-service-a-core-used-for-coding)).
- **Docker — for an isolated chat and sprout core** (a household or team bot). The container sees
  only its volume: no projects, no personal logins ([Container](#container)). Don't bind-mount a
  host directory into it to "give it a project": the container's `node` user (uid 1000) often
  doesn't match the owner's uid (a macOS user is 501), so files come out unreadable or
  wrong-owned; file sharing on macOS Docker is slow; and delegates run with permissions skipped,
  so the mount hands that whole directory to anyone who can run a delegate. Need projects? Run a
  native core instead.

One data directory runs one scheduler, so run one core per `~/.bean` (or per volume).

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
logins. It needs Node 24 or newer (`brew install node` on macOS; NodeSource's Node 24.x on Linux).
Each release attaches `bean-core-<ver>.tar.gz` (+ `.sig`, Ed25519, same key as the desktop
update): one artifact for macOS and Linux. `pnpm pack:core` builds the same tarball into `release/`.

Install as the account the core will serve (not root; the installer calls `sudo` itself):

```bash
tar xzf bean-core-<ver>.tar.gz
./bean-core-<ver>/install.sh            # --tz America/Toronto to override the detected time zone
```

It checks Node (missing or older than 24: it prints how to install it and changes nothing), then:

- copies the release to `~/.local/share/bean-core/versions/<ver>/` and points `current` at it
  (the version it replaces becomes `previous`);
- writes `/usr/local/bin/bean-core` (sudo), a wrapper with absolute paths, because a
  non-interactive SSH session's `PATH` is minimal and `bean-core attach` must still resolve;
- writes `~/.bean/config.json` as `{ "openaiApiKey": "" }` (0600) if there is none, so the
  service boots; paste the key in the shell's Settings;
- installs and starts the service with the system time zone as `TZ`:
  - **macOS:** LaunchAgent `~/Library/LaunchAgents/dev.bean.core.plist` (`RunAtLoad`,
    `KeepAlive`), log `~/Library/Logs/bean-core.log`. A LaunchAgent starts at login, so to keep
    Bean running across a reboot with nobody at the screen, turn on automatic login for that
    account. Install from a logged-in session (a LaunchAgent needs the GUI session).
  - **Linux:** `/etc/systemd/system/bean-core.service` (sudo; `User=` you, `Restart=always`),
    enabled and started. Log: `journalctl -u bean-core -f`.
- waits for the boot line (`bean-core on: …`) and prints it, or the first error, then
  `Add this core in Bean: <user>@<host>`.

Day to day:

```bash
./bean-core-<newer>/install.sh   # upgrade: installs that version, flips current/previous, restarts
bean-core rollback               # swap current and previous, restart
bean-core --version              # prints `bean-core <ver> contract <n>`; reads nothing
./bean-core-<ver>/install.sh --uninstall   # or ~/.local/share/bean-core/current/install.sh --uninstall
```

`--uninstall` stops and removes the service, the wrapper and every installed version. It keeps
`~/.bean` (config, memories, notes, sprouts) and the macOS log; delete them yourself.

If `node` comes from nvm, the installer warns: the service runs that exact binary and breaks when
that Node version is removed. Re-run the installer after switching Node. Do not run the desktop
app's local core on the same `~/.bean`: it stands by while `bean-core` holds the lease.

Restart by hand: `launchctl kickstart -k gui/$(id -u)/dev.bean.core` (macOS) or
`sudo systemctl restart bean-core` (Linux).

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

Run one container per volume. The image puts `bean-core` on `/usr/local/bin` for remote attach.

## Teams ingress

Discord needs no inbound port. Teams does: Microsoft's Bot Service must reach the bot's messaging
endpoint (port 3978 by default, `port` in `teams.json`), at `https://<public-host>/api/messages` set
as the Azure Bot messaging endpoint.

- **Native:** set the `"devtunnel"` key in `teams.json` and the bot runs `devtunnel host` for you
  (setup in `packages/teams/README.md`), or put your own HTTPS reverse proxy in front of 3978.
- **Container:** the image does not include `devtunnel`, so the `"devtunnel"` key does not work
  inside it. Either publish the port (`-p 3978:3978`) behind your own HTTPS reverse proxy, or run
  `devtunnel host -p 3978` on the Docker host and use its URL plus `/api/messages`.

## Attach a desktop shell (SSH only)

`bean-core` listens on a unix socket, `~/.bean/core.sock` (0600, inside the 0700 data directory).
It opens no TCP port. A desktop app on another machine reaches it through SSH, which pipes stdio
to that socket:

```bash
ssh <user@host> bean-core attach                         # native (bean-core on the remote PATH)
ssh <user@host> docker exec -i bean bean-core attach     # container named bean
```

**On the core's machine:**

1. `bean-core` is running (service or container) as the user you'll SSH in as — the socket lives
   in that user's `~/.bean`.
2. SSH is on. macOS: System Settings → General → Sharing → Remote Login. Linux: `sshd`.
3. Native: the `bean-core` wrapper the installer writes ([Native service](#native-service-a-core-used-for-coding)).
   Container: the SSH user can run `docker` (in the `docker` group).

**On the shell's machine — SSH keys only** (Bean never asks for or stores a password):

- **macOS:** `ssh-keygen -t ed25519` (skip if `~/.ssh/id_ed25519` exists), then
  `ssh-copy-id <user@host>`. It accepts the host key and installs your key.
- **Windows:** the built-in OpenSSH client (Settings → System → Optional features → OpenSSH
  Client). In PowerShell, `ssh-keygen -t ed25519`, then
  `type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh <user@host> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"`.
- Check: `ssh <user@host> command -v bean-core` prints a path with no password prompt. Bean runs
  SSH with `BatchMode=yes` and `StrictHostKeyChecking=yes`, so an unknown host key or a missing
  key fails instead of prompting.

**In Bean:** open the **Cores** panel (tray → Core → Add Core…, or the avatar when no core is
attached), enter `user@host` and, for Docker, the container name, then **Add core** and **Use**.
Bean restarts attached to it. If the first attach fails, the panel shows SSH's error and the
one-time setup line above for this OS. The Windows app has no local core, so it always attaches.

One shell is attached at a time: attaching from a second machine takes over, and the first one
shows "Attached from another machine" with a Take back button. A dropped connection keeps the
core's delegates and live sessions running for 30 minutes and replays their output on reconnect.

The socket refuses everything outside a small allowlist (chat turns, agent sessions, delegates,
read-only catalogs, and Settings with the API key write-only). Path opens, terminals, Mac control
and the Terminal.app hand-off are never reachable remotely, so the shell hides them. If another
`bean-core` is already serving the same data directory, the second one logs
`bean-core: remote attach is off — …` and keeps running without a socket.

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
