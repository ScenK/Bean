# Route by Bean's own capabilities, not the harness's

`converse()`'s routing rule (`behaviorInstructions` in `core/src/converse.ts`) decides
"answer myself vs hand off" by **what the task needs**, checked against Bean's own closed
capability set (plain conversation plus the tools passed in that request). A result that
fits in chat text (answering, drafting, rewriting, brainstorming) stays with Bean. Anything
that needs files, a shell, the web or current data, or a change in an external system goes
to `propose_delegate`, biased toward hand-off when unsure (the confirm card makes a needless
hand-off cheap). The hand-off wording is only included when `propose_delegate` is actually
offered; otherwise Bean is told to say it can't. Don't over-widen it to "anything created":
that sends plain drafting work to the harness.

**Web search (config `webSearch`, default off) splits "the web" into public vs private.**
With it on, Bean searches the public web itself (OpenAI's built-in `web_search`, run
server-side in the same call) for news/docs/releases/facts and ends with a `Source:` line.
The user's own repos, tickets, mail, calendar, team, deployments, and accounts are worded
as a *fact* — "never on the public web" — not a prohibition, so the model doesn't search,
find nothing, and guess; those still hand off (or are declined without a delegate). Flag
off keeps the old "web or current data → agent" wording byte-for-byte. Any edit to this
wording must re-run the live guardrails: `converse-web-search.live.test.ts` (skipped
without `BEAN_LIVE_OPENAI_KEY`) — the fake-chat unit tests can't see routing behavior.

**Why:** the old rule described the *harness's* job ("project work", "inspect a linked
project"). The harness's real reach (MCP servers like Jira, auth, skills) is invisible to
Bean, so anything in between got misrouted. Seen in practice: "create a Jira ticket" in Teams
made Bean draft the ticket in chat, because it wasn't "project work" and `propose_delegate`
*required* a project. Don't go back to listing harness task types, and don't list the
harness's tools in the prompt either. That list goes stale.

`propose_delegate`'s `project` is optional when the caller passes `scratchPath`
(`scratchDir(beanDir)`, created at startup by main.ts and both chatops servers). An omitted
project runs the delegate in that scratch workspace. Scratch delegates share the per-project
run lock in chatops `runs.ts`, so only one runs at a time.
