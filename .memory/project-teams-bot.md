# project-teams-bot

Bean has two chat adapters over one shared brain:

- **Brain**: `packages/core/src/chatops/` — `bot.ts` (buildTeamsBot; name kept for history),
  conversation/proposal/run stores, cli-model resolve. Pure/DI'd; card builders are injected
  via `CardBuilders` (`cards-api.ts`), so the brain has zero presentation code.
- **Adapters**: `packages/teams/` (Azure Bot + Adaptive Cards + tunnel; work group) and
  `packages/discord/` (gateway + embeds/buttons; personal, allowlist-only). Each is
  config + card builders + one impure `server.ts`.
- Specs: docs/superpowers/specs/2026-07-10-teams-bot-design.md and
  2026-07-10-discord-adapter-design.md.
- `converse()` grew a trailing `availableClis` param; `ProposedDelegate` has optional
  `cli`/`model` (chat-stated). Backward-compatible; the desktop ignores them so far.
- Model memory keys `teams:cli` / `teams:model:<cli>` are intentionally shared by ALL chat
  adapters (historical name) in ~/.bean/model-memory.json beside the desktop's skillName
  keys. Don't rename or "clean up" either side.
- Conversation/proposal state is in-memory by design (POC): restart = amnesia.
- Settings has a "CHAT BOTS" section (Start/Stop per bot) wired via `packages/app/src/chatops-servers.ts`
  (`createChatopsServers`): Electron main spawns `node packages/{discord,teams}/dist/server.js` as a
  plain child process (repo root resolved the same way `projectBeanDir()` does) and tracks running/error
  state, broadcast to renderer via `bean:chatops-event`. Dev-only by construction — packaged builds don't
  ship `packages/discord`/`packages/teams`, so the buttons only work from a repo checkout (same
  precondition as `~/.bean/discord.json`/`teams.json` existing at all). Requires `pnpm --filter @bean/discord
  build` (and teams) first; missing dist surfaces as an inline error instead of throwing.
- Auth is **Single Tenant**, not the design doc's original Multi Tenant: Azure Bot Service
  stopped offering "Multi Tenant" as an app-registration type in the portal for new bots
  (security hardening on Microsoft's side). `TeamsConfig` requires `tenantId` alongside
  `botAppId`/`botAppPassword`; `server.ts` passes `MicrosoftAppTenantId` into
  `ConfigurationServiceClientCredentialFactory` with `MicrosoftAppType: "SingleTenant"`.
  User-Assigned Managed Identity (the portal's other option) is not viable here — it only
  issues credentials to workloads running on Azure compute, and this bot runs on the
  owner's Mac behind a dev tunnel.
