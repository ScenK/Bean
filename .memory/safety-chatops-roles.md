# Chatops roles: owner / admin / guest (#254)

Teams and Discord speakers get one of three roles from `core/src/chatops/roles.ts` `makeRoles()`:
**owner** (config `ownerId`, global), **admin** (granted per channel / group chat by the owner with
`add-admin @x`, `bean.db` `chatops_admins`), **guest** (everyone else: Bean's own model only).
Desktop and routines run as the owner and are untouched.

- **Enforcement is two layers — keep both.** (1) `onMessage` builds the tool list, catalog and
  memories from the role (guests get `[]` for all of them). (2) Runtime checks: `converse()` refuses
  any tool call that wasn't offered this turn (it used to act on `propose_delegate` whenever
  `scratchPath` was set), and `bot.ts` re-checks the role before acting on each `result.proposed*`.
- **Card taps check the role before `claim()`** (`cardActionNeeds`), so a refused tap leaves the card
  usable. Discord gates its own selects/modals/edit buttons with the same table *before* they mutate
  pending state; a new Discord-only component id must be named so `cardActionNeeds` maps it right
  (`live-*` / `*-live` / `*-skill` = owner).
- **Admin scope is the channel, not the thread**: Discord thread → parent channel (computed before
  `startThread`), Teams channel → `bareChannelId`. History/cards/runs keep the full conversation id.
  DMs never have admins. An admin's `cancel` / `cancel-run` only touches runs started from the same
  conversation (`RunRegistry.cancel(path, conversationId)`).
- **Fail closed**: no owner (Teams setup mode) or no actor id = guest; `roles` is a required dep.
  Identity comes only from platform ids (`from.id`, `aadObjectId`, `author.id`), never names.
- **Role check runs before paid pre-work**: a non-owner DM with `allowGuestDms` off gets no
  transcription/downloads, then one fixed line per user per process (`whoami` still answers).
- Admins are trusted operators of the owner's Mac (delegates bypass permissions) — accepted.
  The role line in the trailing system message is guidance only; never treat it as the gate.
- Live sessions: every *launch* entry point is owner-only; steering a running one keeps the
  starter/co-driver/war-room model ([project-live-sessions](project-live-sessions.md)).
