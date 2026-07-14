# Skill self-authoring (propose_skill)

`converse()` offers `propose_skill` on every call (all channels). It is confirm-first like
notes: `ConverseResult.proposedSkill` → SkillCard (desktop) or skillProposalCard +
SkillProposalStore (chatops) → `saveSkill(skillsDir(~/.bean), name, body)`. Name validation in
converse mirrors saveSkill's traversal guard — keep them in sync. The built-in
`.bean/skills/generate-skill.md` (target: chat) is the authoring-expertise skill; adding any
built-in skill requires updating `builtin-skills.test.ts`'s shipped-list assertion, and adding
any always-on converse tool requires updating converse.test.ts's tool-list assertions.
