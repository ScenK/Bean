import type { SproutRunPlan } from "../sprout-trigger.js";

/** A sprout-run card awaiting a Run/Check or Cancel tap (#636). The action is frozen in `plan`;
 * a tap only names the proposal. */
export interface PendingSproutRun {
  id: string;
  plan: SproutRunPlan;
  conversationId: string;
  /** Platform id of whoever asked: only they may tap (owner-only today, but a second owner id
   * or a forged tap must not reuse someone else's card). */
  proposedById: string;
  /** Where the finish reply goes: a channel/thread id, absent for a DM (the owner's DM). */
  channel?: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** One-shot like TodoProposalStore: claim() removes, so a replayed tap can't run twice. */
export class SproutRunProposalStore {
  private byId = new Map<string, PendingSproutRun>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingSproutRun, "id" | "createdAt">): PendingSproutRun {
    const full: PendingSproutRun = { ...p, id: `sprout-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  /** Read without claiming — for checks that must leave a refused card usable. */
  peek(id: string): PendingSproutRun | undefined {
    return this.byId.get(id);
  }

  claim(id: string): PendingSproutRun | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
