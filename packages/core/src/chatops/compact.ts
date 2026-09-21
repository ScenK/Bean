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

async function compactOnce(
  conversationId: string,
  conversations: ConversationStore,
  deps: ConverseDeps,
): Promise<void> {
  if (conversations.turnCount(conversationId) <= COMPACT_THRESHOLD) return;
  const oldest = conversations.oldest(conversationId, SUMMARIZE_COUNT);
  const summary = await summarizeTurns(oldest, deps);
  conversations.replaceOldest(conversationId, SUMMARIZE_COUNT, { role: "system", content: summary });
}

// ponytail: in-process serialization only. A conversation belongs to exactly one bot process
// in practice, so that's enough; if two processes ever drive the same conversation id, this
// needs a real lock on the SQLite row instead.
const inFlight = new Map<string, Promise<void>>();

/** Silent and automatic — unlike memory consolidation this is pure efficiency, not a
 * data-loss-risk decision: it's the same "old context eventually falls away" tradeoff the
 * previous in-memory MAX_TURNS slice already made, just smarter (a summary instead of a hard
 * drop). Call fire-and-forget right after appending a turn; never blocks the reply.
 *
 * Serialized per conversation because callers fire-and-forget it from several places (an
 * inbound turn in bot.ts, each delivered outbox message in the bot servers). Two overlapping
 * passes would otherwise both snapshot the same oldest turns, and the second replaceOldest
 * would delete the first's summary along with newer turns and write a stale summary over them. */
export async function maybeCompact(
  conversationId: string,
  conversations: ConversationStore,
  deps: ConverseDeps,
): Promise<void> {
  const prev = inFlight.get(conversationId) ?? Promise.resolve();
  const run = prev.then(() => compactOnce(conversationId, conversations, deps));
  // The queued link must never reject, or one failure poisons every later waiter; `run` itself
  // still rejects so this caller sees the error.
  const link = run.catch(() => {});
  inFlight.set(conversationId, link);
  void link.then(() => { if (inFlight.get(conversationId) === link) inFlight.delete(conversationId); });
  return run;
}
