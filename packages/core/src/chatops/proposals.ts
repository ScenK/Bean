import type { CliName } from "../launcher.js";
import type { ProposedDelegate } from "../converse.js";

export interface PendingProposal {
  id: string;
  proposal: ProposedDelegate;
  conversationId: string;
  proposedBy: string;
  /** The proposer's platform id (authenticated adapter field) for the run's audit row. */
  proposedById: string;
  channelName?: string;
  /** The model's instruction, kept only when the confirmer edited it on the card. */
  instructionProposed?: string;
  defaultCli: CliName;
  defaultModel?: string;
  cardActivityId?: string;
  /** A fallback card for a `continue` that didn't match its grant (epic #1111): it launches a fresh
   * session, never the thread's earlier one. */
  fresh?: true;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;
/** Cap on a hand-edited instruction — matches the Discord modal's max_length. */
export const MAX_INSTRUCTION_CHARS = 4000;

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

  /** Raw read (expired entries included, nothing claimed) — bot.ts tells a held-but-expired card
   * from a consumed or forged id with it. */
  peek(id: string): PendingProposal | undefined {
    return this.byId.get(id);
  }

  /** Non-removing peek for the edit-prompt flow; undefined once expired or claimed. Doesn't
   * delete an expired entry — claim() stays the only removal path. */
  get(id: string): PendingProposal | undefined {
    const p = this.byId.get(id);
    if (!p || this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }

  /** Apply an edit-prompt change. Deliberately leaves createdAt alone: an edit doesn't extend expiry. */
  updateInstruction(id: string, instruction: string): void {
    const p = this.get(id);
    if (p) p.proposal = { ...p.proposal, instruction };
  }

  claim(id: string): PendingProposal | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
