import type { ConsolidationResult } from "../memory/consolidate.js";

/** A pending confirm-first memory consolidation (merges/drops) awaiting an Apply/Cancel tap. */
export interface PendingConsolidation {
  id: string;
  result: ConsolidationResult;
  conversationId: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending confirm-first consolidation proposals — the tidy-up counterpart to
 * MemoryProposalStore. claim() is one-shot so two members tapping Apply on the same card
 * can't double-apply. */
export class ConsolidationProposalStore {
  private byId = new Map<string, PendingConsolidation>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingConsolidation, "id" | "createdAt">): PendingConsolidation {
    const full: PendingConsolidation = { ...p, id: `cons-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  claim(id: string): PendingConsolidation | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
