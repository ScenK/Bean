import type { ProposedTodo } from "../converse.js";

/** A pending confirm-first todo draft awaiting a Queue/Cancel tap on its card. */
export interface PendingTodo {
  id: string;
  todo: ProposedTodo;
  conversationId: string;
  proposedBy: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending confirm-first todo proposals — the todo counterpart to ProposalStore.
 * claim() is one-shot so two members tapping Queue on the same card can't double-queue. */
export class TodoProposalStore {
  private byId = new Map<string, PendingTodo>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingTodo, "id" | "createdAt">): PendingTodo {
    const full: PendingTodo = { ...p, id: `todo-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  claim(id: string): PendingTodo | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
