import { CARD_RECORD_PREFIX, isCardRecord } from "../card-record.js";
import type { ChatTurn } from "../converse.js";
import type { LiveCli } from "../live-session.js";
import type { ConversationKind } from "./catalog.js";
import { formatSummaryBlock } from "./compact.js";

// A chatops history as display rows: the desktop's synced-chat view and the owner's DM exchanges in
// the main conversation (#1000) both read `chatops_turns` through this.

/** One transcript line, already mapped for display: the owner's lines lose their `[Name]:`
 * prefix, others keep the name; `[live session]` finals are the agent's; a compaction summary is a
 * status row. Context blocks the bot stored for the model (ambient chatter, replied-to) are left out. */
export type SyncedChatRow =
  | { role: "user"; text: string; name?: string }
  | { role: "bean"; text: string }
  | { role: "agent"; text: string; agent?: LiveCli }
  | { role: "status"; text: string };

const SUMMARY_PREFIX = formatSummaryBlock("");
const LIVE_PREFIX = "[live session] ";
const SPEAKER = /^\[([^\]\n]*)\]: ([\s\S]*)$/;

/** One stored turn as display rows (none for a context block). */
export function mapSyncedTurn(t: ChatTurn, row: { kind: ConversationKind; liveCli?: LiveCli }, ownerName: string): SyncedChatRow[] {
  if (t.role === "assistant") {
    if (t.content.startsWith(LIVE_PREFIX)) {
      return [{ role: "agent", text: t.content.slice(LIVE_PREFIX.length), ...(row.liveCli ? { agent: row.liveCli } : {}) }];
    }
    // A confirm card's record line (#941) is Bean's bookkeeping, not something it said.
    if (isCardRecord(t.content)) return [{ role: "status", text: `Card: ${t.content.slice(CARD_RECORD_PREFIX.length).replace(/\]$/, "")}` }];
    return [{ role: "bean", text: t.content }];
  }
  if (t.role !== "user") return [];
  if (t.content.startsWith(SUMMARY_PREFIX)) return [{ role: "status", text: "Earlier messages were summarized." }];
  const m = SPEAKER.exec(t.content);
  if (!m) return [];
  const [, name = "", text = ""] = m;
  // A DM is the owner's own; elsewhere the owner's desk and platform turns carry the configured name.
  return [row.kind === "dm" || name === ownerName ? { role: "user", text } : { role: "user", text, name }];
}

export function mapSyncedTranscript(
  turns: ChatTurn[], row: { kind: ConversationKind; liveCli?: LiveCli }, ownerName: string,
): SyncedChatRow[] {
  return turns.flatMap((t) => mapSyncedTurn(t, row, ownerName));
}
