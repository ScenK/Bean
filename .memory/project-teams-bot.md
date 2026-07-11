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
