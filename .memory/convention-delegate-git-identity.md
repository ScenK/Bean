---
name: convention-delegate-git-identity
description: delegate spawns inject GIT_AUTHOR_NAME/EMAIL so headless CLI commits are attributed to Bean, not the local user
metadata:
  type: convention
---

`BEAN_GIT_IDENTITY` (`packages/core/src/agent-rules.ts`) sets
`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` — default `Bean
<bean@localhost>`, overridable in Settings ("Commit as" = `config.json` `gitName`/`gitEmail`).
The object is **mutable on purpose**: host's runtime config calls `setBeanGitIdentity` at boot and
on every Settings save, and every spawn site spreads it into the child `env` *at spawn time*, so a
save reaches the next run with nothing threaded through. Don't snapshot it into a module-level
copy, and any new CLI spawn path (delegate or live) must spread it too, or that path's commits
fall back to the host's global git config identity.

Env vars only set the commit's identity *fields* — GitHub only shows a contributor badge for a
name that also appears in the message body. `withCliRules` therefore appends
`gitTrailerInstruction()` (computed per call from the same identity) to every delegated prompt and
live-session opening, asking the CLI to add a `Co-Authored-By: <name> <email>` trailer if it commits — the same mechanism Claude Code's
own commits use for its own attribution. This does **not** change who authenticates the push or
`gh pr create` call: that still runs on the local user's SSH key / `gh` token, since neither spawn
site touches `SSH_AUTH_SOCK` or git credentials. Giving Bean its own push/PR identity would need a
separate SSH deploy key or bot GitHub account/PAT — bigger scope, not done here.
