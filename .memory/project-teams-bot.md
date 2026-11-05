# project-teams-bot

Bean has two chat adapters over one shared brain:

- **Brain**: `packages/core/src/chatops/` — `bot.ts` (buildTeamsBot; name kept for history),
  conversation/proposal/run stores, cli-model resolve. Pure/DI'd; card builders are injected
  via `CardBuilders` (`cards-api.ts`), so the brain has zero presentation code.
- **Adapters**: `packages/teams/` (Azure Bot + Adaptive Cards + tunnel; work group) and
  `packages/discord/` (gateway + embeds/buttons; personal, allowlist-only). Each is
  config + card builders + one impure `server.ts`.
- `converse()` grew a trailing `availableClis` param; `ProposedDelegate` has optional
  `cli`/`model` (chat-stated). Backward-compatible; the desktop ignores them so far.
- Model memory keys `teams:cli` / `teams:model:<cli>` are intentionally shared by ALL chat
  adapters (historical name) in ~/.bean/model-memory.json beside the desktop's skillName
  keys. Don't rename or "clean up" either side.
- The live-session card's picks live in the same file as `live:project` / `live:cli` /
  `live:model:<cli>` / `live:skill` (`""` = none/CLI default), saved on a fresh Start (never a
  resume) and used as a new card's defaults when still valid. A chat-stated project/cli/model
  wins; only `/live-session` (no project in mind) takes the remembered project. Steering is
  deliberately not remembered (war-room must be a per-card choice).
- Conversation/proposal state is in-memory by design (POC): restart = amnesia.
- Settings has a "CHAT BOTS" section (Start/Stop per bot) wired via `packages/app/src/chatops-servers.ts`
  (`createChatopsServers`): Electron main spawns a plain child `node` process and tracks running/error
  state, broadcast to renderer via `bean:chatops-event`. Dev uses `packages/{discord,teams}/dist/server.js`;
  packaged builds ship bundled bot servers under `Resources/chatops/{discord,teams}/server.js` and pass
  `BEAN_BUILTIN_DIR=Resources/builtin` so the bot can load built-in skills/persona without a repo checkout.
  Requires `~/.bean/discord.json`/`teams.json`; missing dev dist still surfaces as an inline error.
- Auth is **Single Tenant**, not the design doc's original Multi Tenant: Azure Bot Service
  stopped offering "Multi Tenant" as an app-registration type in the portal for new bots
  (security hardening on Microsoft's side). `TeamsConfig` requires `tenantId` alongside
  `botAppId`/`botAppPassword`; `server.ts` passes `MicrosoftAppTenantId` into
  `ConfigurationServiceClientCredentialFactory` with `MicrosoftAppType: "SingleTenant"`.
  User-Assigned Managed Identity (the portal's other option) is not viable here — it only
  issues credentials to workloads running on Azure compute, and this bot runs on the
  owner's Mac behind a dev tunnel.
- **Managed devtunnel** (`"devtunnel"` in teams.json, `packages/teams/src/devtunnel.ts`): the
  server logs in with `devtunnel user login --sp-*` as the bot's own app registration — the
  secret goes via `DEVTUNNELS_SP_SECRET` env, never argv. Don't switch it to `devtunnel user
  login` (browser/user session): that session expiring silently taking the bot offline is the
  whole reason this exists. Verified that the bot's SP can create tunnels in the emetric tenant.
  The tunnel *name* is not in its URL (Microsoft FAQ) — the URL is stable only while the tunnel
  exists (30-day sliding expiry); a recreated tunnel means re-pasting the Azure endpoint.
- **Bot scopes**: `teamsAppManifest/manifest.json` `bots[0].scopes` is
  `["personal", "groupChat", "team"]`. `personal` is what makes 1:1 chats work — without it
  Teams never installs into / delivers a direct message, even though the *code* has always
  handled personal (`addressedToBot` returns true for `conversationType === "personal"`, and
  the outbox DMs personal conversations). The blocker was purely the manifest scope; don't
  drop `personal` back to group-only.
- **Ambient channel history**: when mentioned, the bot injects recent non-mention channel
  messages as one synthetic user-role history turn (`BotEffects.fetchRecent`, fixed
  15-min/50-msg window, `chatops/ambient.ts`). Discord fetches on demand via
  `channel.messages.fetch` (no extra intents). Teams needs RSC permissions in the app
  manifest (`ChannelMessage.Read.Group` + `ChatMessage.Read.Chat`) to receive non-mention
  messages at all; without them the feature silently no-ops. Non-mention Teams messages are
  stored in the `AmbientStore` (`chatops_ambient` table in `bean.db`, 200/conversation, survives
  restarts) and never replied to.
- **Reminders**: Teams passes `reminders: { transport: "teams" }`; core stamps the full ingress
  conversation id as the target, the desktop app's reminder loop enqueues it to the outbox, and
  the Teams drain posts to exactly that id (`;messageid=` = thread reply). No reminder loop in
  the Teams server — reminders fire only while Bean.app runs (late after it was off). The receipt
  card's When uses Adaptive Card `{{DATE()}} {{TIME()}}`, which needs a `Z` RFC 3339 string with no
  milliseconds (`reminderCard` normalises).
- **Desk ingress** (#528, `chatops/desk.ts`): the desktop app sends `desk-turn {requestId,
  conversationId, text}` over the bot's IPC slot; the bot answers `desk-ack` (ok or one fixed
  refusal code) and pings `saved {conversationId}` from `ConversationStore.onChange`. **No text
  ever goes bot → app** — parsers rebuild each message from known fields. `bot.onDeskTurn` checks
  before any platform call: cap (`too-long`), catalog row (`no-record`), row owner is the owner
  *now* (`not-eligible`), a live session the owner can't steer (`channel-busy`), 4 in flight
  (`bot-busy`). It acts as the catalog's `owner_id` (never an id from the request), posts the
  `🖥 (desk): <text>` echo via `fx.post` (not history; failure = `post-failed`, no turn), then acks
  ok and runs `onMessage` — or steers a running live session (`queue-full` when refused). The ack
  means "accepted", not "answered": the app times out at 15s and never resends (a lost ack may
  have run the turn). A bot exit fails pending requests. Teams (#529) has no turn context
  for a desk turn: every effect goes proactive on the stored `teams-conversations.json` ref
  (`proactive.ts`'s `refFor` — bare channel id finds the ref, the full `;messageid=` id is the
  send target, same as the outbox); a conversation with no stored ref fails the echo → `post-failed`.
- **Desk continue** (#695, `desk-continue`): app → bot `{ mode: "chat", channelId, title, tail,
  count }` or `{ mode: "agent", channelId, title, sessionId }`; mixed or over-cap payloads
  are dropped. `bot.onDeskContinue` takes the owner from config (never the request), asks the
  surface's `openThread` (Discord: GuildText + CreatePublicThreads + SendMessagesInThreads, OneDay,
  **no channel fallback**), catalogs it, saves the tail once as a framed `> `-quoted user turn
  (`formatCarriedBlock`; no memory capture), and posts `<@owner> Continued from Bean desktop · N
  messages carried over` with `allowedMentions: { users: [owner] }`. Ack is ok + `threadId`,
  `partial` + `threadId` (thread made, a later step failed), or a fixed refusal — still no text.
  `DeskContinueResult` is its own type so turn/resume consumers never see `partial`.
  **Agent mode** (#696) moves an idle desktop CLI session: `findDelegateRun(id, "desktop")` must
  pass *before* the thread opens; then a `delegate_runs` row for this surface is appended
  (`recordDelegateRun` must return true and a plain lookup must resolve it here) — the newest row
  is the one owner, so the desktop's lookup now refuses it. The thread is bound (`live_cli`/
  `live_session_id`), a live card posted and kept (its idle end offers Continue live), and the
  session resumes restricted with the config owner as starter. Any failure after the thread exists
  posts the reason there and acks `partial`; it never starts fresh — recovery is Continue live.
  **Desktop side** (#697, `app/src/desk-continue.ts`, IPC `deskContinue`): the chat header's Continue in
  Discord (`ContinueDiscord.tsx`) picks a labelled Discord `channel` destination (last pick in
  `localStorage`); main re-checks it against `listDestinations`, refuses off-the-record chats, and
  serializes per mount. Agent mode goes through `liveTasks.handover`: refused while a turn runs, stops
  the session, waits for its `ended` (onExit), then holds the CLI id (resume refused) until the ack. On
  ok/partial the chat saves a `{ kind: "continued" }` pointer (kept by `chat-thread.ts`) and switches to
  the thread's synced view; a chat holding one is read-only (Open thread, no composer, no Continue live,
  pending cards expired). "Idle" = no turn running *and* no send accepted mid-turn (its follow-up turn
  is still to come — `onTurnStart` re-marks busy). A pending request counts as the chat's work: it stays
  mounted and a window close awaits the ack, so the pointer is never lost. A refused agent move leaves a
  status row with the stopped session's receipt (Continue live here).
- **Sprout triggers** (#637, `chatops/sprout-bridge.ts`): an app-spawned bot has no scheduler
  (`BEAN_HEADLESS_ROUTINES` is cleared), so its sprout-run card tap sends `routine-trigger
  {requestId, name, action, origin}` over the same IPC slot (still no message text bot → app). The app
  (`chatops-servers.ts` → `main.ts`) re-resolves the name with `loadRoutines()` (gone = `missing`) and
  re-plans with `planSproutRun` — a sprout whose plan changed since the card (paused, emptied, run ↔
  check) is refused, never run as something the owner didn't confirm — then triggers and posts the
  finish reply itself via the outbox (`withFinishReply`, transport = the asking bot). It answers
  `routine-trigger-result` (started / one fixed refusal code / a check count). Bot side
  (`parentSproutTrigger`): a reply settles only a request it is waiting on; app disconnect, a failed
  send or 2 min silence → "Bean's desktop app isn't reachable"/"didn't answer". No resend. Taps
  before the app's scheduler exists (bots autostart first) answer `unavailable`.
