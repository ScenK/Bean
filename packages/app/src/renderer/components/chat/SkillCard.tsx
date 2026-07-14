import { useState } from "preact/hooks";
import type { ProposedSkill } from "@bean/core";

/** Draft-skill confirm card: name and body editable until confirmed. skill.updating =
 * a skill with this name already exists, so Save replaces/overrides it. */
export function SkillCard({
  skill,
  state,
  onSave,
  onDismiss,
}: {
  skill: ProposedSkill;
  state: "pending" | "saved" | "dismissed";
  onSave: (edited: ProposedSkill) => void;
  onDismiss: () => void;
}) {
  const [name, setName] = useState(skill.name);
  const [body, setBody] = useState(skill.body);
  const done = state !== "pending";

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">{skill.updating ? "update skill" : "draft skill"}</span>
        {skill.updating ? <span class="bean-chip">replaces existing</span> : null}
      </div>
      <input
        class="bean-input bean-input--boxed"
        type="text"
        value={name}
        disabled={done}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <textarea
        class="bean-card-prompt"
        value={body}
        disabled={done}
        onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
      />
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={done} onClick={() => onSave({ ...skill, name, body })}>
          {state === "saved" ? "Saved" : skill.updating ? "Update skill" : "Save skill"}
        </button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={done} onClick={onDismiss}>
          {state === "dismissed" ? "Dismissed" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
