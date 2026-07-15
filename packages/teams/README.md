# @bean/teams — Bean as a Teams group-chat bot (POC)

Local Node server that lets a Teams group chat @mention Bean. Chat goes through
`converse()`; delegate runs (headless `claude`/`opencode`) are confirm-first via an
Adaptive Card and execute on THIS machine. Design: `docs/superpowers/specs/2026-07-10-teams-bot-design.md`.

## One-time setup

1. **Azure Bot registration** (free tier): portal.azure.com → "Azure Bot" → create with
   type *Single Tenant* (Azure no longer offers *Multi Tenant* for new registrations).
   Note the **Microsoft App ID** and the **Tenant ID** shown on the bot's Overview page —
   this must be your organization's actual Microsoft 365 tenant ID (Teams admin center →
   Org settings → Org info), not a different Azure subscription's tenant, or Teams will
   silently refuse to route any conversation to the bot.
2. **Client secret** — NOT created on the bot resource, it lives on the underlying app
   registration: portal search bar → **"App registrations"** (under Microsoft Entra ID,
   formerly Azure AD). If it doesn't show under **Owned applications**, check **All
   applications** — someone else may have created it for you, in which case you also need
   to be added as an **Owner** on it (or have them create the secret and hand you the value)
   before **+ New client secret** will work. Open the entry whose **Application (client)
   ID** matches the Microsoft App ID above → **Certificates & secrets** → **Client secrets**
   tab → **+ New client secret**. After clicking Add, copy the **Value** column immediately
   (shown once) — that's `botAppPassword`, not the Secret ID column.
3. **Enable the Microsoft Teams channel** — Azure Bot resource → **Channels** → add
   **Microsoft Teams** → Save. Easy to skip, and skipping it doesn't fail loudly: the bot
   still answers Test-in-Web-Chat and any direct HTTP call fine, but adding it to an actual
   Teams chat fails with a generic "Bad Request" (backend error text, if you can see it:
   `Failed to execute Skype backend request BulkMembershipRequest`) because Teams has no
   channel registration to attach chat membership to. If you hit that error and everything
   else (endpoint, auth, tenant) checks out, this is almost certainly why — check it first.
4. **Config**: create `~/.bean/teams.json`:
   `{ "botAppId": "<app-id>", "botAppPassword": "<client-secret>", "tenantId": "<tenant-id>", "port": 3978 }`
5. **Tunnel** (macOS): install via `curl -sL https://aka.ms/DevTunnelCliInstall | bash`
   (adds `devtunnel` to `~/bin` — put that on `PATH`, e.g. `export PATH="$HOME/bin:$PATH"`
   in `~/.zshrc`), then `devtunnel user login` once. Run `devtunnel host -p 3978
   --allow-anonymous` — it mints a **new random URL every restart**, so if you're going to
   stop/start it a lot, make it persistent instead: `devtunnel create --allow-anonymous` →
   `devtunnel port create -p 3978` → `devtunnel host` (same URL forever after that). Set the
   bot's **messaging endpoint** (Azure Bot resource → Configuration) to
   `https://<tunnel-id>.devtunnels.ms/api/messages` — note the trailing **`/api/messages`**
   (plural); `/api/message` is a common typo and 404s silently as a Teams-side "Bad Request".
   (Bot Framework JWT auth on the endpoint is the real access gate; the anonymous tunnel only
   exposes reachability.) Sanity-check reachability directly:
   `curl -i -X POST https://<tunnel-id>.devtunnels.ms/api/messages -d '{}'` should return
   **401 Unauthorized** (proves the tunnel + server are up and the auth gate is live — a 404
   means the path is wrong, a connection error means the tunnel or server is down).
6. **Teams app package**: `teamsAppManifest/` next to this README holds a fill-in template —
   `id` needs a fresh GUID (`uuidgen`), `bots[0].botId` and `webApplicationInfo.id` = the App
   ID. It needs two icons: `color.png` (192×192) and `outline.png` (32×32) — generic starter
   ones (Bean's own logo, resized) are already in this folder; swap in your own with
   `sips -z 192 192 logo.png --out color.png` (macOS built-in, no extra tooling) if you want
   something else. Zip the three files **flat, no subfolder** (`zip -j app.zip manifest.json
   color.png outline.png`) and upload via Teams → Apps → Manage your apps → **Upload a
   custom app**.
   - **Corporate tenants**: if you don't have direct upload rights, this doesn't fail — it
     silently routes into a **custom app submission queue** instead (you'll see it under
     Apps → Manage your apps → **Pending requests**). There's no default notification for
     this; an admin has to know to look. Tell them where: Teams admin center → Manage apps
     → change **Filter by action** to **Apps requests** (or just search the app name) → open
     it → **User requests** tab → **Approve**. They can also set up a **Rule** there to get
     notified automatically next time. After approval the app is unblocked org-wide, but
     nobody has it *installed* yet — you (or anyone) still add it from Apps → search the name.
7. **Ambient channel history (optional)**: for "@Bean summarize the last 10 minutes" to see
   messages that didn't mention Bean, the manifest must grant the RSC (resource-specific
   consent) permissions already present in the template — `ChannelMessage.Read.Group` (team
   channels) and `ChatMessage.Read.Chat` (group chats) under `authorization.permissions.resourceSpecific`.
   These are purely a Teams-manifest/consent mechanism (a team owner or chat member consents
   when installing) — no corresponding Azure AD app-registration permission is needed. With
   RSC granted, Teams delivers *every* channel message to the bot; Bean stores the
   non-mention ones in memory (last ~200 per conversation, lost on restart) and never replies
   to them. Without RSC, everything else still works — Bean just can't see ambient chatter.

## Testing before rolling out to the org

Three ways to validate the bot without touching your employer's tenant or IT policy:

- **[Microsoft 365 Agents Playground](https://learn.microsoft.com/microsoft-365/agents-sdk/test-with-toolkit-project)**
  — replacement for the now-deprecated Bot Framework Emulator, fastest loop. No tunnel, no
  Teams channel, no manifest upload needed. Since this bot uses `SingleTenant` auth, use
  *authenticated* mode (anonymous mode won't pass the JWT check):
  ```bash
  npx @microsoft/m365agentsplayground -e "http://localhost:3978/api/messages" -c "emulator" \
    --client-id "<app-id>" --client-secret "<client-secret>" --tenant-id "<tenant-id>"
  ```
  Renders Adaptive Cards (including clicking Run/Cancel) same as Teams. Good for iterating
  on `bot.ts`/`cards.ts` behavior.
- **Azure Bot resource → Settings → "Test in Web Chat"** — quick sanity check that the
  server/tunnel/auth chain works end-to-end, straight from the Azure portal.
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

In the packaged desktop app, the tray menu's **Teams** toggle spawns this exact same built
`dist/server.js` (via Electron's bundled Node) — don't also run `pnpm --filter @bean/teams
start` at the same time, they'll fight over port 3978.

## Troubleshooting "Bad Request" when adding the bot to a chat

Roughly in order of likelihood — check each before changing config, since most of these fail
silently with the same generic Teams error and guessing wastes a round trip:

1. **Teams channel not enabled** on the Azure Bot resource (see step 3 above) — the most
   common cause. Symptom: endpoint answers fine directly (curl gets 401) and Test in Web
   Chat works, but the add-to-chat call never even reaches your server.
2. **Wrong/typo'd messaging endpoint path** — must end in `/api/messages` (plural).
3. **Stale tunnel URL** — `devtunnel host` (non-persistent) mints a new URL every restart;
   confirm the URL it's currently printing matches what's saved in Azure Bot → Configuration.
4. **Tenant mismatch** — `teamsConfig.tenantId` must be your org's actual Microsoft 365
   tenant ID, not whatever Azure subscription/tenant the app registration happened to be
   created under.
5. To see the *real* error instead of the generic toast: reproduce on `teams.microsoft.com`
   in a browser with DevTools open (Network tab, filter fetch/XHR) — the failing request's
   response body has Microsoft's actual `errorCode`/`message`.

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
