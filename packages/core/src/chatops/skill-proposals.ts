import type { ProposedSkill } from "../converse.js";

/** A pending confirm-first skill draft awaiting a Save/Cancel tap on its card. */
export interface PendingSkill {
  id: string;
  skill: ProposedSkill;
  conversationId: string;
  proposedBy: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending confirm-first skill proposals — the skill counterpart to NoteProposalStore.
 * claim() is one-shot so two members tapping Save on the same card can't double-save. */
export class SkillProposalStore {
  private byId = new Map<string, PendingSkill>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingSkill, "id" | "createdAt">): PendingSkill {
    const full: PendingSkill = { ...p, id: `skill-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  claim(id: string): PendingSkill | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
