/** A channel message Bean was not addressed in, kept as context for later mentions. */
export interface AmbientMessage {
  fromName: string;
  text: string;
  /** epoch ms */
  at: number;
}

// ponytail: in-memory ring buffer, restart = amnesia — same accepted POC tradeoff as ConversationStore.
const MAX_MESSAGES = 200;

/** Per-conversation store of ambient (non-mention) channel messages. */
export class AmbientStore {
  private byId = new Map<string, AmbientMessage[]>();

  append(conversationId: string, msg: AmbientMessage): void {
    const msgs = [...(this.byId.get(conversationId) ?? []), msg];
    this.byId.set(conversationId, msgs.slice(-MAX_MESSAGES));
  }

  since(conversationId: string, sinceMs: number): AmbientMessage[] {
    return (this.byId.get(conversationId) ?? []).filter((m) => m.at >= sinceMs);
  }
}

/** One history block the model reads before the mention that triggered it. */
export function formatAmbientBlock(messages: AmbientMessage[]): string {
  const lines = messages.map((m) => {
    const d = new Date(m.at);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `<${hh}:${mm}> ${m.fromName}: ${m.text}`;
  });
  return `[Recent channel messages, for context — not addressed to you]\n${lines.join("\n")}`;
}
