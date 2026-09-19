# `hidden: true` skills — fully invisible, effectively undeletable

`Skill.hidden` (frontmatter `hidden: true`, parsed in `skill-library.ts`) is distinct from the
two user-facing toggles: `enabled: false` switches a skill off everywhere (quick-launch, the
desktop chat catalog, chatops, routine pickers and routine execution) while still listing it
(grayed out) in the Skills panel, and `quick-launch: false` hides it from the avatar's drag
bloom only — chat and chatops still route to it. `hidden: true` removes it from *every* renderer
surface — Skills panel, quick-launch tiles, the Projects panel's default-skill picker, and the
ChatWindow's skill list — all of which read from the single `bean:list-skills` IPC call.
`buildListSkillsHandler` (`app/src/ipc.ts`) is the one filter point (`.filter(s => !s.hidden)`);
no per-component change needed for a new hidden skill.

Both toggles are opt-out (absent key = on) and both are ignored by `fingerprint()` in
`skill-library.ts`, so flipping either on a built-in skill doesn't make its shadow copy count as
a user customization.

`converse()` still routes against hidden skills: `buildChatHandler` loads skills via its own
`deps.loadSkills` call, not through `buildListSkillsHandler`, so a hidden skill stays usable —
just never user-visible or user-selectable.

The built-in `bean` self-intro skill (`.bean/skills/bean.md`) is the first user: `hidden: true`
plus the pre-existing fact that `deleteSkill` (IPC) only ever touches the user skills dir, never
`.bean/skills/` — so it was already effectively undeletable through the app; `hidden` just keeps
it from showing up (and thus being selectable for delete/edit) in the Skills panel at all.
