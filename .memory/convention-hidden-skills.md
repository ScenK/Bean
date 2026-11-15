# `hidden: true` skills — fully invisible, effectively undeletable

`Skill.hidden` (frontmatter `hidden: true`, parsed in `skill-library.ts`) is distinct from the
two user-facing toggles: `enabled: false` switches a skill off everywhere (quick-launch, the
desktop chat catalog, chatops, routine pickers and routine execution) while still listing it
(grayed out) in the Skills panel, and `quick-launch: false` hides it from the avatar's drag
bloom only — chat and chatops still route to it. `hidden: true` removes it from *every* renderer
surface — Skills panel, quick-launch tiles, the Projects panel's default-skill picker, and the
ChatWindow's skill list — all of which read from the single `bean:list-skills` IPC call.
`buildListSkillsHandler` (`host/src/handlers.ts`) is the one filter point (`.filter(s => !s.hidden)`);
no per-component change needed for a new hidden skill.

Both toggles are opt-out (absent key = on) and both are ignored by `fingerprint()` in
`skill-library.ts`. A toggle-only save of a built-in (`saveSkill` given the built-in dir) writes a
**toggle overlay** — a user file with only the flags that differ, no body — which
`loadLayeredSkills` layers onto the built-in's *current* body (#877). Never write a full shadow
copy for a toggle: it pins the old body and swallows later built-in updates. Legacy full copies
that still match the built-in modulo toggles stay tagged built-in.

`converse()` still routes against hidden skills: `buildChatHandler` loads skills via its own
`deps.loadSkills` call, not through `buildListSkillsHandler`, so a hidden skill stays usable —
just never user-visible or user-selectable.

The built-in `bean` self-intro skill (`.bean/skills/bean.md`) is the first user: `hidden: true`
plus the pre-existing fact that `deleteSkill` (IPC) only ever touches the user skills dir, never
`.bean/skills/` — so it was already effectively undeletable through the app; `hidden` just keeps
it from showing up (and thus being selectable for delete/edit) in the Skills panel at all.
