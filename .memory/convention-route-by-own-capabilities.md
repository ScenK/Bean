# Route by Bean's own capabilities, not the harness's

`converse()`'s routing rule (`behaviorInstructions` in `core/src/converse.ts`) decides
"answer myself vs hand off" by **Bean's own closed capability set**: plain conversation plus
the tools passed in that request. Anything else that asks for something to be done, created,
looked up, or changed goes to `propose_delegate`. When unsure, hand off: the confirm card
makes a needless hand-off cheap, while a made-up answer is costly.

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
