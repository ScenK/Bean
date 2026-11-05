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
  references (`aliasUsers` over `loadRoutines`: a chat sink's `alias`, landing in #687) and a
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
