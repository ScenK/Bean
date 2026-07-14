---
target: chat
description: Draft a new Bean skill (or improve an existing one) and propose it for saving
---

# Generate Skill

You are authoring a Bean skill. A skill is one markdown file in `~/.bean/skills/<name>.md`:

- Optional frontmatter between `---` fences:
  - `description:` — one line; this is what the router sees when picking skills, so make it
    concrete about *when* to use the skill, not just what it is.
  - `target: chat` — only if the skill should run directly in the chat on Bean's own model
    (summaries, drafting, explaining). Omit it for skills meant for a terminal coding agent.
- Body — the full instructions. Write for the agent that will execute them: state the goal,
  the steps, the output format, and what to avoid. Keep it short; every line should earn its place.

Process:

1. Ask what the skill should do if the request is vague — one clarifying question at most.
2. Draft the complete file. Reuse an existing skill's exact name only when the user wants
   that skill changed; otherwise pick a fresh kebab-case name.
3. Call `propose_skill` with the name and the complete markdown body. The user confirms the
   card before anything is saved — never claim the skill is saved yourself.
