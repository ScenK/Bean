---
name: convention-delegate-git-identity
description: delegate spawns inject GIT_AUTHOR_NAME/EMAIL so headless claude/opencode commits are attributed to Bean, not the local user
metadata:
  type: convention
---

`BEAN_GIT_IDENTITY` (`packages/core/src/delegate.ts`) sets
`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` to `Bean
<bean@localhost>`. It's merged into the spawn `env` in both `defaultDelegateSpawn` (core) and
`resolvedPathSpawnFn` (`packages/app/src/delegate-tasks.ts`) — the two places a delegate child
actually gets spawned. Any new delegate spawn path must merge it too, or that path's commits
will fall back to the host's global git config identity.

Env vars only set the commit's identity *fields* — GitHub only shows a contributor badge for a
name that also appears in the message body. `delegateCommand()` therefore appends
`GIT_TRAILER_INSTRUCTION` (exported for tests) to every delegated prompt, asking the CLI to add a
`Co-Authored-By: Bean <bean@localhost>` trailer if it commits — the same mechanism Claude Code's
own commits use for its own attribution. This does **not** change who authenticates the push or
`gh pr create` call: that still runs on the local user's SSH key / `gh` token, since neither spawn
site touches `SSH_AUTH_SOCK` or git credentials. Giving Bean its own push/PR identity would need a
separate SSH deploy key or bot GitHub account/PAT — bigger scope, not done here.
