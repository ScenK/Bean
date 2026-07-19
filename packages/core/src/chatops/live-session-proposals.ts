import type { ProposedLiveSession } from "../converse.js";

/** A pending confirm-first live-session launch awaiting a Start/Cancel tap on its card. */
export interface PendingLiveSession {
  id: string;
  proposal: ProposedLiveSession;
  conversationId: string;
  proposedBy: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending confirm-first live-session proposals — the live-session counterpart to
 * ProposalStore. claim() is one-shot so two members tapping Start on the same card
 * can't double-launch. */
export class LiveSessionProposalStore {
  private byId = new Map<string, PendingLiveSession>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingLiveSession, "id" | "createdAt">): PendingLiveSession {
    const full: PendingLiveSession = { ...p, id: `live-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  /** Non-removing peek — the on-card project/model pickers and the edit-prompt modal read and
   * mutate the pending proposal across several interactions before Start finally claims it. */
  get(id: string): PendingLiveSession | undefined {
    return this.byId.get(id);
  }

  /** Apply an on-card edit (project/model pick, or a modal prompt edit) to a pending proposal. */
  update(id: string, patch: Partial<Pick<ProposedLiveSession, "projectPath" | "instruction" | "model" | "skillName" | "steering">>): void {
    const p = this.byId.get(id);
    if (p) p.proposal = { ...p.proposal, ...patch };
  }

  claim(id: string): PendingLiveSession | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
