import type { CliName } from "../launcher.js";
import type { ProposedDelegate } from "../converse.js";

export interface PendingProposal {
  id: string;
  proposal: ProposedDelegate;
  conversationId: string;
  proposedBy: string;
  defaultCli: CliName;
  defaultModel?: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending confirm-first delegate proposals. claim() is one-shot so two members
 * tapping Run on the same card can't double-launch. */
export class ProposalStore {
  private byId = new Map<string, PendingProposal>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingProposal, "id" | "createdAt">): PendingProposal {
    const full: PendingProposal = { ...p, id: `prop-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  claim(id: string): PendingProposal | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
