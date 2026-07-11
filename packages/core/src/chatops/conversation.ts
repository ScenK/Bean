import type { ChatTurn } from "../converse.js";

// 40 turns ≈ 20 user/assistant exchanges — enough thread context without unbounded growth.
const MAX_TURNS = 40;

/** In-memory per-thread chat history. Restart = amnesia, accepted for the POC (see spec). */
export class ConversationStore {
  private byId = new Map<string, ChatTurn[]>();

  history(conversationId: string): ChatTurn[] {
    return this.byId.get(conversationId) ?? [];
  }

  append(conversationId: string, turn: ChatTurn): void {
    const turns = [...(this.byId.get(conversationId) ?? []), turn];
    this.byId.set(conversationId, turns.slice(-MAX_TURNS));
  }
}
