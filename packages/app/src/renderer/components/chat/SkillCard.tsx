import { useState } from "preact/hooks";
import type { ProposedSkill, Skill } from "@bean/core";

/** Draft-skill confirm card: name and body editable until confirmed. `collides` (live,
 * recomputed from the current `name` against the real skills list) drives the "replaces
 * existing" chip/label — skill.updating is only the initial-render assumption, since the
 * user can edit the name to collide with (or diverge from) a different existing skill. */
export function SkillCard({
  skill,
  skills,
  state,
  onSave,
  onDismiss,
}: {
  skill: ProposedSkill;
  skills: Skill[];
  state: "pending" | "saved" | "dismissed";
  onSave: (edited: ProposedSkill) => void;
  onDismiss: () => void;
}) {
  const [name, setName] = useState(skill.name);
  const [body, setBody] = useState(skill.body);
  const done = state !== "pending";

  const trimmedName = name.trim();
  // Same traversal guard as SkillsPanel's saveNew/the shared saveSkill writer.
  const nameInvalid = !trimmedName || /[/\\]|\.\./.test(trimmedName);
  const collides = !nameInvalid && skills.some((s) => s.name === trimmedName);

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">{collides ? "update skill" : "draft skill"}</span>
        {collides ? <span class="bean-chip">replaces existing</span> : null}
      </div>
      <input
        class="bean-input bean-input--boxed"
        type="text"
        value={name}
        disabled={done}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      {nameInvalid ? (
        <div class="bean-skills-error">{trimmedName ? "Name can't contain / \\ or .." : "Name is required"}</div>
      ) : null}
      <textarea
        class="bean-card-prompt"
        value={body}
        disabled={done}
        onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
      />
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={done || nameInvalid} onClick={() => onSave({ ...skill, name: trimmedName, body })}>
          {state === "saved" ? "Saved" : collides ? "Update skill" : "Save skill"}
        </button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={done} onClick={onDismiss}>
          {state === "dismissed" ? "Dismissed" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
