import type { ImageAttachment, ProposedNote } from "../converse.js";

/** A pending confirm-first note draft awaiting a Save/Cancel tap on its card. */
export interface PendingNote {
  id: string;
  note: ProposedNote;
  conversationId: string;
  proposedBy: string;
  cardActivityId?: string;
  createdAt: number;
  /** Chat images to store in note_images and append as bean-image refs on Save. */
  images?: ImageAttachment[];
}

const EXPIRY_MS = 10 * 60_000;
/** Global cap on image bytes held in memory (recent slots + pending proposals), oldest evicted first. */
const MAX_HELD_BYTES = 64 * 1024 * 1024;

const heldBytes = (images: ImageAttachment[] | undefined): number =>
  (images ?? []).reduce((n, i) => n + Math.ceil((i.data.length * 3) / 4), 0);

/** Pending confirm-first note proposals — the note counterpart to ProposalStore.
 * claim() is one-shot so two members tapping Save on the same card can't double-save.
 * Also holds each conversation's most recent chat images (never persisted to chatops_turns)
 * so "save that image to a note" works on a follow-up message within the expiry window. */
export class NoteProposalStore {
  private byId = new Map<string, PendingNote>();
  private recent = new Map<string, { images: ImageAttachment[]; at: number }>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now(), private maxHeldBytes = MAX_HELD_BYTES) {}

  add(p: Omit<PendingNote, "id" | "createdAt">): PendingNote {
    const full: PendingNote = { ...p, id: `note-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    this.prune();
    return full;
  }

  /** Keeps `images` as the conversation's recent-images slot (replacing any earlier one). */
  rememberImages(conversationId: string, images: ImageAttachment[]): void {
    if (images.length === 0) return;
    this.recent.delete(conversationId); // re-insert so Map order stays oldest-first
    this.recent.set(conversationId, { images, at: this.nowMs() });
    this.prune();
  }

  recentImages(conversationId: string): ImageAttachment[] | undefined {
    const r = this.recent.get(conversationId);
    return r && this.nowMs() - r.at <= EXPIRY_MS ? r.images : undefined;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  /** One-shot. With `conversationId`, a card tapped from another conversation claims nothing
   * and leaves the proposal in place. */
  claim(id: string, conversationId?: string): PendingNote | undefined {
    const p = this.byId.get(id);
    if (!p || (conversationId !== undefined && p.conversationId !== conversationId)) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }

  /** Drops expired entries, then evicts the oldest image holders until under the byte cap.
   * An evicted proposal is removed whole — saving it without the images its card promised
   * would be a silent loss; its Save then reports the draft expired. */
  private prune(): void {
    const now = this.nowMs();
    for (const [k, r] of this.recent) if (now - r.at > EXPIRY_MS) this.recent.delete(k);
    for (const [k, p] of this.byId) if (now - p.createdAt > EXPIRY_MS) this.byId.delete(k);
    const holders = [
      ...[...this.recent].map(([k, r]) => ({ at: r.at, bytes: heldBytes(r.images), drop: () => this.recent.delete(k) })),
      ...[...this.byId].filter(([, p]) => p.images?.length)
        .map(([k, p]) => ({ at: p.createdAt, bytes: heldBytes(p.images), drop: () => this.byId.delete(k) })),
    ].sort((a, b) => a.at - b.at);
    let total = holders.reduce((n, h) => n + h.bytes, 0);
    for (const h of holders) {
      if (total <= this.maxHeldBytes) break;
      h.drop();
      total -= h.bytes;
    }
  }
}
