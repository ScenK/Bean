import type { ProposedTodo } from "@bean/core";

/** Draft-todo confirm card: unlike Note/SkillCard there's only one field to show (the todo
 * text), so it's a read-only card rather than an editable draft. Run now runs only this task;
 * Queue puts it in line (#923). Either way `result` says what happened and the task's own result
 * comes back to this chat. */
export function TodoCard({
  todo,
  state,
  result,
  onRun,
  onQueue,
  onDismiss,
}: {
  todo: ProposedTodo;
  state: "pending" | "sending" | "queued" | "running" | "done" | "dismissed" | "expired";
  result?: string;
  onRun: () => void;
  onQueue: () => void;
  onDismiss: () => void;
}) {
  const done = state !== "pending";
  const ahead = todo.ahead === undefined ? undefined : todo.ahead === 0 ? "nothing ahead in queue" : `${todo.ahead} ahead in queue`;

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">{`Sprout "${todo.routine}"`}</span>
      </div>
      <div class="bean-card-prompt">{todo.text}</div>
      {state === "pending" && (
        <div class="bean-offer-ask">{`Run now runs only this task${ahead ? ` · Queue: ${ahead}` : ""}`}</div>
      )}
      {result !== undefined && <div class="bean-offer-ask" role="status">{result}</div>}
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={done} onClick={onRun}>
          {state === "running" ? "Running…" : "Run now"}
        </button>
        <button type="button" class="bean-btn" disabled={done} onClick={onQueue}>
          {state === "queued" ? "Queued" : "Queue"}
        </button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={done} onClick={onDismiss}>
          {state === "dismissed" ? "Dismissed" : state === "expired" ? "Expired" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
