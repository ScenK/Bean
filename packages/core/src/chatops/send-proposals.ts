import { randomUUID } from "node:crypto";
import type { DestinationKey } from "../destinations.js";

/** An owner-DM send card (#689) awaiting Send or Cancel. The body is frozen here; a tap only
 * names the proposal and (Teams) the picked option id. */
export interface PendingSend {
  id: string;
  conversationId: string;
  /** Platform id of whoever asked: only they may tap. */
  proposedById: string;
  body: string;
  /** Opaque option id → row: every in-scope labelled destination when the card was built. */
  rows: Map<string, DestinationKey>;
  /** The current pick (the confident match, then Discord's select changes); absent = none. */
  pick?: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** One-shot like SproutRunProposalStore: claim() removes, so a replayed Send can't post twice.
 * Ids are random, not sequential: a card from before a bot restart must never name a new proposal. */
export class SendProposalStore {
  private byId = new Map<string, PendingSend>();
  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingSend, "id" | "createdAt">): PendingSend {
    const full: PendingSend = { ...p, id: `send-${randomUUID()}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  setPick(id: string, pick: string): void {
    const p = this.byId.get(id);
    if (p && p.rows.has(pick)) p.pick = pick;
  }

  /** Read without claiming — for checks that must leave a refused card usable. */
  peek(id: string): PendingSend | undefined {
    return this.byId.get(id);
  }

  claim(id: string): PendingSend | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
