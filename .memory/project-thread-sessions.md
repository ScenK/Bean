# project-thread-sessions

Sessions in chatops are **platform threads**: one Discord thread / one Teams channel post =
one `chatops_turns` history (already true, since `conversationId` is the thread/post id) plus
one resumable delegate session **per CLI** (`thread_sessions`, keyed `(conversation_id, cli)`). Bean opens the Discord
thread on a top-level @mention; on Teams the user's new post is the session. DMs, Teams group
chats and personal chats have no threads and stay single-session on purpose.

Decided against: any text session list (`/sessions`, `/resume <n>` — PR #153, closed), a
Claude-API brain, and reworking live sessions. Delegate follow-ups inside a thread reuse that thread's session for the picked CLI —
never lock resume to claude; per-CLI choice is Bean's point. Each CLI's own resume is used, no
transcript replay: `claude -p --resume <id>` (id from the `system`/`init` event), `codex exec
resume … -- <id> <prompt>` (`thread.started.thread_id`), `opencode run --format json --session
<id>` (`sessionID` on every event — why opencode delegates now run `--format json`). All three
exit 1 on an unknown id; `runDelegate` treats "non-zero exit before the session-started event"
as a rejected resume and re-spawns fresh once (result prefixed with a notice). A resumed run's reservation stays on the bot's own pid
until the session-started event (`onSessionStart`), because a rejected first child dies and
would make the project reclaimable mid-run — don't armor that with ownership checks — never fail the run for it. `/new` clears the
thread's sessions too, and a run launched before the `/new` doesn't store its id afterwards. Routine `DelegateStepRequest.resume` is not wired yet (follow-up). A follow-up on another project starts fresh on **every** CLI (#558): `RunRegistry.start` keeps
a resume only when the session's newest `delegate_runs` row is for the same project (no row = fresh)
and prefixes a path-free "earlier <cli> session was on another project" notice. claude and codex
*do* resume across folders (carrying the old project's paths into a permission-bypassing run, and
drifting "Continue live" to the new project); opencode hangs. No re-key of `thread_sessions`, so
A→B→A starts fresh again. It also drops a resume while the same
thread already has an active run on that CLI (two processes must never drive one session); the
result is prefixed with a "Started a fresh session" notice, and the thread pointer keeps whichever
run completes last. `RunRegistry` is keyed by run id (the running card's Cancel carries `runId`;
a card without one is treated as gone), still one run per project path. Delegate spawns also
set `PWD: cwd`: opencode prefers an inherited `PWD` over the spawn cwd, so a shell-started Bean ran
it in the shell's dir (#247).
