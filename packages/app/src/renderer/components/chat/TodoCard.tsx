import type { ProposedTodo } from "@bean/core";

/** Draft-todo confirm card: unlike Note/SkillCard there's only one field to show (the todo
 * text), so it's a read-only card rather than an editable draft — Queue just confirms
 * `${routine}`/`${text}` as-is instead of re-composing an edited object like onNoteSave does. */
export function TodoCard({
  todo,
  state,
  onQueue,
  onDismiss,
}: {
  todo: ProposedTodo;
  state: "pending" | "queued" | "dismissed";
  onQueue: () => void;
  onDismiss: () => void;
}) {
  const done = state !== "pending";

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">{`Queue on "${todo.routine}"`}</span>
      </div>
      <div class="bean-card-prompt">{todo.text}</div>
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={done} onClick={onQueue}>
          {state === "queued" ? "Queued" : "Queue"}
        </button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={done} onClick={onDismiss}>
          {state === "dismissed" ? "Dismissed" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
