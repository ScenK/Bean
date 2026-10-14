# Chatops roles: owner / admin / member / guest (#254, #280)

Teams and Discord speakers get one of four roles (`guest < member < admin < owner`) from
`core/src/chatops/roles.ts` `makeRoles()`: **owner** (config `ownerId`, global), **admin** (granted
per channel / group chat by the owner with `add-admin @x`, `bean.db` `chatops_admins`), **member**
(Discord config `memberIds`, household-wide so DMs too, restart to change; Teams has none yet),
**guest** (everyone else: Bean's own model only). Desktop and routines run as the owner.

- **Capabilities, not role names**: `NEEDS` in roles.ts maps each capability to its least role
  and `can(role, cap)` reads it — the tool list, `permitted()` runtime checks and `cardActionNeeds`
  all go through it. Members get memory, notes and todos only: no delegates, chat skills, images,
  `system_control`, live sessions, skill writes or run cancels. A member refusal says the owner
  sets those up (`memberRefusal`), never "ask to be made admin".
- **DM gate** is `dmAllowed(role, roles)` (member+, or `allowGuestDms`) in both `bot.ts` and the
  surfaces' pre-work gates. The non-member DM line points at `whoami`.
- **Live capture runs before role checks** and grants nothing by role: steering is only
  starter/co-driver/war-room. Don't add member steering there.

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
