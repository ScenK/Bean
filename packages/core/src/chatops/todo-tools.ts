import type { ActionTool } from "../converse.js";
import type { TodoItem } from "../todo-store.js";

export interface TodoToolDeps {
  /** `createdBy` set = only that speaker's todos (filtered in SQL); absent = everyone's. */
  list: (createdBy?: string) => Promise<TodoItem[]>;
  /** False = no such pending todo (or not that speaker's). */
  cancel: (id: string, createdBy?: string) => Promise<boolean>;
  /** The speaker's platform id — never from the model. */
  speakerId: string;
  /** The owner lists and cancels anyone's; everyone else only their own. */
  isOwner: boolean;
}

/** Per-turn chatops list_todos / cancel_todo over queued routine todos (#283). */
export function makeTodoTools(deps: TodoToolDeps): ActionTool[] {
  const who = deps.isOwner ? undefined : deps.speakerId;
  return [
    {
      spec: {
        name: "list_todos",
        description: "List the speaker's queued (pending or running) routine todos.",
        parameters: { type: "object", properties: {} },
      },
      run: async () => {
        const open = (await deps.list(who)).map(({ id, routine, text, status }) => ({ id, routine, text, status }));
        return open.length === 0 ? "no queued todos" : JSON.stringify(open);
      },
    },
    {
      spec: {
        name: "cancel_todo",
        description: "Cancel one pending (not yet running) todo by id (from list_todos).",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "the todo id" } },
          required: ["id"],
        },
      },
      run: async (args) => {
        const { id } = (args ?? {}) as { id?: unknown };
        if (typeof id !== "string" || !id) return "error: cancel_todo needs { id }";
        return (await deps.cancel(id, who)) ? `cancelled todo ${id}` : "no such pending todo of yours";
      },
    },
  ];
}
