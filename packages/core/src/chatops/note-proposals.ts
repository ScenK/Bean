import type { ProposedNote } from "../converse.js";

/** A pending confirm-first note draft awaiting a Save/Cancel tap on its card. */
export interface PendingNote {
  id: string;
  note: ProposedNote;
  conversationId: string;
  proposedBy: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending confirm-first note proposals — the note counterpart to ProposalStore.
 * claim() is one-shot so two members tapping Save on the same card can't double-save. */
export class NoteProposalStore {
  private byId = new Map<string, PendingNote>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingNote, "id" | "createdAt">): PendingNote {
    const full: PendingNote = { ...p, id: `note-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  claim(id: string): PendingNote | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
