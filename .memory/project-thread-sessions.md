# project-thread-sessions

Sessions in chatops are **platform threads**: one Discord thread / one Teams channel post =
one `chatops_turns` history (already true, since `conversationId` is the thread/post id) plus,
once step 3 lands, one claude session id used for `claude -p --resume`. Bean opens the Discord
thread on a top-level @mention; on Teams the user's new post is the session. DMs, Teams group
chats and personal chats have no threads and stay single-session on purpose.

Decided against: any text session list (`/sessions`, `/resume <n>` — PR #153, closed), a
Claude-API brain, and reworking live sessions. Spec with the three ordered steps:
`docs/superpowers/specs/2026-09-26-thread-sessions-design.md` (delete after merge, keep this
entry). Delegate follow-ups inside a thread must reuse that thread's claude session — don't
start every delegate from zero once the mapping table exists.
