# @bean/teams — Bean as a Teams group-chat bot (POC)

Local Node server that lets a Teams group chat @mention Bean. Chat goes through
`converse()`; delegate runs (headless `claude`/`opencode`) are confirm-first via an
Adaptive Card and execute on THIS machine. Design: `docs/superpowers/specs/2026-07-10-teams-bot-design.md`.

## One-time setup

1. **Azure Bot registration** (free tier): portal.azure.com → "Azure Bot" → create with
   type *Single Tenant* (Azure no longer offers *Multi Tenant* for new registrations).
   Note the **Microsoft App ID** and the **Tenant ID** (Azure AD → Overview, or the linked
   app registration's "Directory (tenant) ID"); create a **client secret** under the linked
   app registration. Enable the **Microsoft Teams channel** on the bot resource.
2. **Config**: create `~/.bean/teams.json`:
   `{ "botAppId": "<app id>", "botAppPassword": "<client secret>", "tenantId": "<tenant id>", "port": 3978 }`
3. **Tunnel**: install [devtunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/),
   then `devtunnel host -p 3978 --allow-anonymous`. Set the bot's **messaging endpoint** to
   `https://<tunnel-id>.devtunnels.ms/api/messages`. (Bot Framework JWT auth on the endpoint
   is the access gate; the anonymous tunnel only exposes reachability.)
4. **Teams app package**: create a manifest (id = a new GUID, `bots[0].botId` = the App ID,
   `scopes: ["groupChat", "team"]`) plus two icons, zip them, and upload via Teams →
   Apps → "Upload a custom app" (corporate tenants: IT approval / custom app policy needed).
   The `teamsAppManifest/` folder next to this README holds a fill-in template.
5. **Ambient channel history (optional)**: for "@Bean summarize the last 10 minutes" to see
   messages that didn't mention Bean, the manifest must grant the RSC (resource-specific
   consent) permissions already present in the template — `ChannelMessage.Read.Group` (team
   channels) and `ChatMessage.Read.Chat` (group chats) under `authorization.permissions.resourceSpecific`,
   plus `webApplicationInfo.id` = the App ID. A team owner consents when installing the app.
   With RSC granted, Teams delivers *every* channel message to the bot; Bean stores the
   non-mention ones in memory (last ~200 per conversation, lost on restart) and never replies
   to them. Without RSC, everything else still works — Bean just can't see ambient chatter.

## Testing before rolling out to the org

Two ways to validate the bot without touching your employer's tenant or IT policy:

- **[Bot Framework Emulator](https://github.com/Microsoft/BotFramework-Emulator)** — fastest
  loop. Point it at `http://localhost:3978/api/messages` with the App ID/password/tenant ID
  from step 1. It speaks the same Activity protocol Teams does and renders Adaptive Cards
  (including clicking Run/Cancel), but needs no tunnel, no Teams channel, no manifest upload.
  Good for iterating on `bot.ts`/`cards.ts` behavior.
- **A personal [Microsoft 365 Developer sandbox](https://developer.microsoft.com/microsoft-365/dev-program)**
  — free, self-service tenant where you're Global Admin, so "upload custom apps" and the Azure
  Bot's Teams channel are yours to enable with no approval. Register the bot (step 1), create
  `~/.bean/teams.json` pointing at *that* tenant's App ID/tenant ID, run the tunnel + server,
  and sideload the manifest for yourself only. This is the real Teams client — actual @mention
  and card rendering — entirely outside your org, testing solo (talk to the bot directly; no
  need to invite anyone into the sandbox for this).

## Run

    pnpm build
    pnpm --filter @bean/teams start

Then @mention the bot in the group chat. Saying which CLI/model to use ("with opencode on
GPT-5.5") is honored; otherwise Bean uses the last-used or first-detected CLI. Delegate
results post back to the thread when the run finishes.

## Manual verification checklist

- [ ] Server starts and logs detected CLIs.
- [ ] @Bean hello → replies in-thread.
- [ ] @Bean "summarize the bean repo" → proposal card appears with cli/model dropdowns.
- [ ] Run → card flips to "Running… (started by <you>)", tail lines update.
- [ ] Result posts to the thread; card shows "done".
- [ ] Second confirm on the same project while running → polite refusal.
- [ ] Cancel run → card shows "cancelled".
- [ ] A proposal left >10 min → "expired" on confirm.
- [ ] (RSC granted) chat without mentioning Bean, then "@Bean summarize the last 10 minutes"
      → summary references the ambient messages; the non-mention messages got no reply.
