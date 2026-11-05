# Named chat destinations (#683 epic, store #684)

`bean.db`'s `chat_destinations` (core `destinations.ts`) is the list of Discord/Teams
conversations the bots have seen, keyed `(surface, conversation_id)` (Teams channels by bare
channel id). Not `chatops_conversations` — that one is the owner-only continuation catalog.

- **Writers split:** bots call `recordDestination` (kind, platform/parent names, `last_seen`);
  only the desktop writes `alias`. A sighting without a name never clears a known one
  (`COALESCE`), and an unchanged sighting under an hour old writes nothing — keep that throttle,
  three processes share the file.
- **Bot side (#685):** Teams `destinations.ts` reads names from the activity's `channelData`
  (a stored ref has none, so the outbox records without names and `COALESCE` keeps them);
  targeted `a:` refs are skipped, the meeting title is fetched once per meeting id inside the
  turn (needs the live context). Discord syncs postable (`ViewChannel`+`SendMessages`) guild
  text/announcement channels on ready/guildCreate/channelCreate/Update; threads only when seen.
  Lost access or `channelDelete` → `forgetDestination`, which never deletes an aliased row.
  Every call is wrapped — a failed record must not fail a turn or throw a delivery into retry.
- **Settings UI (#686):** `app/src/destinations.ts` (IPC `destinations*`) feeds core the sprout
  references (`aliasUsers` over `loadRoutines`: a chat sink's `alias`) and a
  "1:1 · <speaker>" hint from `ambientSpeakers` for rows with no platform name. The renderer
  (`settings/DestinationsList.tsx`) disables Rename/Clear for referenced aliases; core still
  refuses them, so the disabled button is UX only.
- **Alias rules:** `alias` is `UNIQUE`, and `setAlias` also refuses a name that normalizes equal
  to another row's alias, platform name or label. Every alias op takes an injected `AliasInUse`
  (sprout references): a referenced alias can't be renamed or cleared, only `retargetAlias`ed to
  a row of the **same surface**.
- **Labels:** alias, else platform name; a shared name gets `(parent)`, then a short id tail.
  Rows with neither have no label and are never offered or matched.
- **Matching is server-side** (`matchDestination(query, rows)`): exact → normalized → all query
  tokens → substring → edit distance (pick ≥ 0.75 and ≥ 0.05 over the runner-up). Several hits at
  a stage = no pick. Callers pass only in-scope rows; the model never supplies an id.
- **Sprout sinks (#687):** `RoutineChatopsSink.alias` (exclusive with `channel`/`user`) is resolved
  by `resolveSinkAlias` at enqueue (`deliverDigest` reads `listDestinations` per digest, so a
  retarget applies to the next run). Unknown alias / wrong platform: the scheduler's
  `sinkProblems` dep marks the run needs-attention with `⚠` lines in the digest *before* the
  record is saved, and the sink posts nowhere — never fall back to the owner DM (an alias-less
  sink means DM). User saves (editor, builder) refuse an unknown alias in `main.ts`
  (`saveKnownSinks`); `chatRoutineProblem` resolves via the bot's `routines.destinations` first.
  Editor (`DestinationPicker.tsx`): picking an unnamed row names it immediately (label, `" 2"` on
  a clash); a raw id with a known row gets "Name it" (`destinationsNameRaw`), which rewrites that
  id → alias in every sprout using it.
- **Desktop send (#688):** `propose_send { destination, text }` is a static spec (no names — an enum
  would bust the prompt cache), offered only when the surface passes `sendAvailable` (desktop:
  `ChatHandlerDeps.proposeSend`). Main (`buildSendHandlers` in `app/src/destinations.ts`) matches the
  spoken name and keeps the proposal (body + opaque option id → row, capped at 50); the renderer's
  `SendCard` sends back only the card id + option id, so it can't edit the body or name an unoffered
  row. Send re-resolves the row (forgotten since → refused), is one-shot, and enqueues
  `{ transport, channel: conversationId, body }` — receipt "Queued → <label>". Restored cards expire.
- **Chatops send (#689): owner's real DM only.** `bot.ts` offers `propose_send` only when
  `isOwner && msg.direct` and the surface wired `send` (also on the chat-skill follow-up hop, same
  gate) — never a channel, group, meeting, human 1:1, Teams targeted `/` pick, or a member's DM,
  because the card lists destination names. The card lists the asking platform's labelled rows only
  (pick → aliased → most recent; Discord shows 25 with the pick first). `send-confirm`/`send-cancel`/
  `send-pick` (Discord's select, routed through core) map to `owner` in `cardActionNeeds`, and
  `handleSendAction` refuses unless `CardAction.direct === true` *before* touching the proposal —
  the adapter derives it (Teams `isDirect`, Discord `isDMBased()`); never infer privacy from a
  missing `scopeId` (targeted Teams picks have none). Teams copies card values through
  `cardActionOf` (`teams/src/proactive.ts`) — add a new card input's id there or it never arrives.
  Send ids are random UUIDs (a pre-restart card must never name a new proposal), and a body over
  `MAX_SEND_CHARS` (4000) gets no card — the card must show everything Send posts.
