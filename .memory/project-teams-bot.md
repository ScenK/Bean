# project-teams-bot

`packages/teams/` (`@bean/teams`) is a third workspace package: a local Express+botbuilder
server exposing Bean to a Teams group chat (spec: docs/superpowers/specs/2026-07-10-teams-bot-design.md).

- Same layering rule as app/: `bot.ts` & stores are pure/DI'd; only `server.ts` touches botbuilder.
- `converse()` grew a trailing `availableClis` param and `ProposedDelegate` optional `cli`/`model`
  fields (chat-stated CLI/model). Backward-compatible; the desktop ignores them so far.
- Model memory keys `teams:cli` / `teams:model:<cli>` share ~/.bean/model-memory.json with the
  desktop's skillName keys — the `teams:` prefix is the collision guard. Don't "clean up" either side.
- Conversation/proposal state is in-memory by design (POC): restart = amnesia.
