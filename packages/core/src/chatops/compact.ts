import type { ChatTurn, ConverseDeps } from "../converse.js";
import type { ConversationStore } from "./conversation.js";

// Above this many raw turns, summarize the oldest chunk instead of letting the conversation
// grow unbounded — the SQLite-backed store no longer has the old in-memory MAX_TURNS=40 hard
// slice, so something has to bound it.
const COMPACT_THRESHOLD = 60;
const SUMMARIZE_COUNT = 40;

export async function summarizeTurns(turns: ChatTurn[], deps: ConverseDeps): Promise<string> {
  const transcript = turns.map((t) => `${t.role}: ${t.content}`).join("\n");
  try {
    const res = await deps.chat({
      model: deps.model,
      messages: [
        {
          role: "system",
          content:
            "Summarize this conversation excerpt into a few dense sentences that preserve durable " +
            "context (decisions, facts, open threads) for the rest of the chat to continue from.",
        },
        { role: "user", content: transcript },
      ],
      tools: [],
    });
    return res.content.trim() || "(earlier conversation summarized)";
  } catch {
    return "(earlier conversation summarized)";
  }
}

/** Silent and automatic — unlike memory consolidation this is pure efficiency, not a
 * data-loss-risk decision: it's the same "old context eventually falls away" tradeoff the
 * previous in-memory MAX_TURNS slice already made, just smarter (a summary instead of a hard
 * drop). Call fire-and-forget right after appending a turn; never blocks the reply. */
export async function maybeCompact(
  conversationId: string,
  conversations: ConversationStore,
  deps: ConverseDeps,
): Promise<void> {
  if (conversations.turnCount(conversationId) <= COMPACT_THRESHOLD) return;
  const oldest = conversations.oldest(conversationId, SUMMARIZE_COUNT);
  const summary = await summarizeTurns(oldest, deps);
  conversations.replaceOldest(conversationId, SUMMARIZE_COUNT, { role: "system", content: summary });
}
