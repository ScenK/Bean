import { randomUUID } from "node:crypto";

/** A pending confirm-first note archive awaiting an Archive/Cancel tap on its card. */
export interface PendingNoteArchive {
  id: string;
  slug: string;
  title: string;
  conversationId: string;
  proposedBy: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending note archives — the archive counterpart to NoteProposalStore. claim() is one-shot and
 * conversation-bound, so a repeated, expired or other-conversation tap archives nothing. Ids are
 * UUIDs, not a counter: after a restart an old card must not claim a new archive of another note. */
export class NoteArchiveProposalStore {
  private byId = new Map<string, PendingNoteArchive>();

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingNoteArchive, "id" | "createdAt">): PendingNoteArchive {
    const now = this.nowMs();
    for (const [k, v] of this.byId) if (now - v.createdAt > EXPIRY_MS) this.byId.delete(k);
    const full: PendingNoteArchive = { ...p, id: `archive-${randomUUID()}`, createdAt: now };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  /** With `conversationId`, a tap from another conversation claims nothing and leaves it in place. */
  claim(id: string, conversationId?: string): PendingNoteArchive | undefined {
    const p = this.byId.get(id);
    if (!p || (conversationId !== undefined && p.conversationId !== conversationId)) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
