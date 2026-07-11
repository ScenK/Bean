import type { MemoryCandidate } from "../memory/memory.js";

/** A pending confirm-first batch of extracted memory candidates awaiting a
 * Remember/Cancel tap on its card. */
export interface PendingMemory {
  id: string;
  candidates: MemoryCandidate[];
  conversationId: string;
  proposedBy: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending confirm-first memory proposals — the memory counterpart to NoteProposalStore.
 * claim() is one-shot so two members tapping Remember on the same card can't double-save. */
export class MemoryProposalStore {
  private byId = new Map<string, PendingMemory>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingMemory, "id" | "createdAt">): PendingMemory {
    const full: PendingMemory = { ...p, id: `mem-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  claim(id: string): PendingMemory | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
