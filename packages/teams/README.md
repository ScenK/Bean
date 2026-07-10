# @bean/teams — Bean as a Teams group-chat bot (POC)

Local Node server that lets a Teams group chat @mention Bean. Chat goes through
`converse()`; delegate runs (headless `claude`/`opencode`) are confirm-first via an
Adaptive Card and execute on THIS machine. Design: `docs/superpowers/specs/2026-07-10-teams-bot-design.md`.

## One-time setup

1. **Azure Bot registration** (free tier): portal.azure.com → "Azure Bot" → create with
   type *Multi Tenant*. Note the **Microsoft App ID**; create a **client secret** under the
   linked app registration. Enable the **Microsoft Teams channel** on the bot resource.
2. **Config**: create `~/.bean/teams.json`:
   `{ "botAppId": "<app id>", "botAppPassword": "<client secret>", "port": 3978 }`
3. **Tunnel**: install [devtunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/),
   then `devtunnel host -p 3978 --allow-anonymous`. Set the bot's **messaging endpoint** to
   `https://<tunnel-id>.devtunnels.ms/api/messages`. (Bot Framework JWT auth on the endpoint
   is the access gate; the anonymous tunnel only exposes reachability.)
4. **Teams app package**: create a manifest (id = a new GUID, `bots[0].botId` = the App ID,
   `scopes: ["groupChat", "team"]`) plus two icons, zip them, and upload via Teams →
   Apps → "Upload a custom app" (corporate tenants: IT approval / custom app policy needed).
   The `teamsAppManifest/` folder next to this README holds a fill-in template.

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
