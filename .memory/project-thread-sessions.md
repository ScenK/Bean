# project-thread-sessions

Sessions in chatops are **platform threads**: one Discord thread / one Teams channel post =
one `chatops_turns` history (already true, since `conversationId` is the thread/post id) plus
one resumable delegate session **per CLI** (`thread_sessions`, keyed `(conversation_id, cli)`). Bean opens the Discord
thread on a top-level @mention; on Teams the user's new post is the session. DMs, Teams group
chats and personal chats have no threads and stay single-session on purpose.

Decided against: any text session list (`/sessions`, `/resume <n>` — PR #153, closed), a
Claude-API brain, and reworking live sessions. Spec with the three ordered steps:
`docs/superpowers/specs/2026-09-26-thread-sessions-design.md` (delete after merge, keep this
entry). Delegate follow-ups inside a thread reuse that thread's session for the picked CLI —
never lock resume to claude; per-CLI choice is Bean's point. Each CLI's own resume is used, no
transcript replay: `claude -p --resume <id>` (id from the `system`/`init` event), `codex exec
resume … -- <id> <prompt>` (`thread.started.thread_id`), `opencode run --format json --session
<id>` (`sessionID` on every event — why opencode delegates now run `--format json`). All three
exit 1 on an unknown id; `runDelegate` treats "non-zero exit before the session-started event"
as a rejected resume and re-spawns fresh once (result prefixed with a notice, `onRespawn`
moves the run reservation to the new child) — never fail the run for it. `/new` clears the
thread's sessions too. Routine `DelegateStepRequest.resume` is not wired yet (follow-up).
