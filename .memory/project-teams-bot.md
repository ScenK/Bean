# project-teams-bot

`packages/teams/` (`@bean/teams`) is a third workspace package: a local Express+botbuilder
server exposing Bean to a Teams group chat (spec: docs/superpowers/specs/2026-07-10-teams-bot-design.md).

- Same layering rule as app/: `bot.ts` & stores are pure/DI'd; only `server.ts` touches botbuilder.
- `converse()` grew a trailing `availableClis` param and `ProposedDelegate` optional `cli`/`model`
  fields (chat-stated CLI/model). Backward-compatible; the desktop ignores them so far.
- Model memory keys `teams:cli` / `teams:model:<cli>` share ~/.bean/model-memory.json with the
  desktop's skillName keys — the `teams:` prefix is the collision guard. Don't "clean up" either side.
- Conversation/proposal state is in-memory by design (POC): restart = amnesia.
- Auth is **Single Tenant**, not the design doc's original Multi Tenant: Azure Bot Service
  stopped offering "Multi Tenant" as an app-registration type in the portal for new bots
  (security hardening on Microsoft's side). `TeamsConfig` requires `tenantId` alongside
  `botAppId`/`botAppPassword`; `server.ts` passes `MicrosoftAppTenantId` into
  `ConfigurationServiceClientCredentialFactory` with `MicrosoftAppType: "SingleTenant"`.
  User-Assigned Managed Identity (the portal's other option) is not viable here — it only
  issues credentials to workloads running on Azure compute, and this bot runs on the
  owner's Mac behind a dev tunnel.
