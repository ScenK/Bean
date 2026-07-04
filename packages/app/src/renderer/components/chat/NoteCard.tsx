import { useState } from "preact/hooks";
import type { ProposedNote } from "@bean/core";

/** Draft-note confirm card: like ProposalCard, everything is editable until confirmed.
 * note.slug present = this chat is linked to that note, so Save updates it in place and
 * "Save as new" is the escape hatch. */
export function NoteCard({
  note,
  state,
  linkedVersion,
  onSave,
  onDismiss,
}: {
  note: ProposedNote;
  state: "pending" | "saved" | "dismissed";
  /** Current version of the linked note, when updating in place. */
  linkedVersion?: number;
  onSave: (edited: ProposedNote, asNew: boolean) => void;
  onDismiss: () => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const done = state !== "pending";
  const updating = note.slug !== undefined;

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">
          {updating && linkedVersion ? `update note · v${linkedVersion} → v${linkedVersion + 1}` : "draft note"}
        </span>
        <span class="bean-chip">{note.project ? `project · ${note.project}` : "general"}</span>
      </div>
      <input
        class="bean-input bean-input--boxed"
        type="text"
        value={title}
        disabled={done}
        onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
      />
      <textarea
        class="bean-card-prompt"
        value={body}
        disabled={done}
        onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
      />
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={done} onClick={() => onSave({ ...note, title, body }, false)}>
          {state === "saved" ? "Saved" : updating ? "Update note" : "Save note"}
        </button>
        {updating ? (
          <button type="button" class="bean-btn bean-btn--ghost" disabled={done} onClick={() => onSave({ ...note, title, body }, true)}>
            Save as new note
          </button>
        ) : null}
        <button type="button" class="bean-btn bean-btn--ghost" disabled={done} onClick={onDismiss}>
          {state === "dismissed" ? "Dismissed" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
