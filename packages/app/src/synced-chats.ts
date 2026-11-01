import { formatSummaryBlock, MAX_DESK_TEXT, type ChatTurn, type ChatopsConversation, type ChatopsSurface, type ConversationKind, type DeskAckResult, type LiveCli } from "@bean/core";

// Synced chats: the owner's Discord/Teams conversations (core chatops/catalog.ts) shown in the
// desktop chat sidebar — a read view over `chatops_turns`, plus desk turns sent through the bot
// (see .memory/project-desktop-chat-history.md → "Synced chats"). Never written to desktop_chats.

/** A sidebar row. `live` = a bot reported a live session running there right now. */
export interface SyncedChatListing {
  surface: ChatopsSurface;
  conversationId: string;
  kind: ConversationKind;
  title: string;
  updatedAt: string;
  live: boolean;
  /** The CLI of the last live session bound here, if any. */
  liveCli?: LiveCli;
  /** That session's id is recorded, so Continue live can reopen it (the id itself stays in main). */
  resumable: boolean;
  /** An archive of earlier history `/new` left behind: read-only, never sent to or resumed. */
  archived: boolean;
}

/** One transcript line, already mapped for display: the owner's lines lose their `[Name]:`
 * prefix, others keep the name; `[live session]` finals are the agent's; a compaction summary is a
 * status row. Context blocks the bot stored for the model (ambient chatter, replied-to) are left out. */
export type SyncedChatRow =
  | { role: "user"; text: string; name?: string }
  | { role: "bean"; text: string }
  | { role: "agent"; text: string; agent?: LiveCli }
  | { role: "status"; text: string };

/** What a desk turn came back with: the bot's ack, or why it never got one. */
export type SyncedSendResult = DeskAckResult | { failed: string };

/** Push to the chat window: re-read this conversation (or, without an id, the whole surface).
 * `saved` = its history changed (an unread dot when it isn't shown). Ids only, never text. */
export interface SyncedChatEvent { surface: ChatopsSurface; conversationId?: string; saved?: boolean }

const SUMMARY_PREFIX = formatSummaryBlock("");
const LIVE_PREFIX = "[live session] ";
const SPEAKER = /^\[([^\]\n]*)\]: ([\s\S]*)$/;

export function mapSyncedTranscript(
  turns: ChatTurn[], row: { kind: ConversationKind; liveCli?: LiveCli }, ownerName: string,
): SyncedChatRow[] {
  return turns.flatMap((t): SyncedChatRow[] => {
    if (t.role === "assistant") {
      if (t.content.startsWith(LIVE_PREFIX)) {
        return [{ role: "agent", text: t.content.slice(LIVE_PREFIX.length), ...(row.liveCli ? { agent: row.liveCli } : {}) }];
      }
      return [{ role: "bean", text: t.content }];
    }
    if (t.role !== "user") return [];
    if (t.content.startsWith(SUMMARY_PREFIX)) return [{ role: "status", text: "Earlier messages were summarized." }];
    const m = SPEAKER.exec(t.content);
    if (!m) return [];
    const [, name = "", text = ""] = m;
    // A DM is the owner's own; elsewhere the owner's desk and platform turns carry the configured name.
    return [row.kind === "dm" || name === ownerName ? { role: "user", text } : { role: "user", text, name }];
  });
}

export interface SyncedChatHandlerDeps {
  dbFile: string;
  owners: () => Promise<Array<{ surface: ChatopsSurface; ownerId: string; ownerName: string }>>;
  listConversations: (file: string, owners: { surface: ChatopsSurface; ownerId: string }[]) => ChatopsConversation[];
  conversationTurns: (file: string, conversationId: string) => ChatTurn[];
  /** Conversation ids with a running live session, per surface (from the bots' `live` activity). */
  liveIds: (surface: ChatopsSurface) => ReadonlySet<string>;
  deskTurn: (surface: ChatopsSurface, conversationId: string, text: string) => Promise<DeskAckResult>;
  deskResume: (surface: ChatopsSurface, conversationId: string) => Promise<DeskAckResult>;
}

/** Handlers behind the synced-chat IPC. Every read and send goes through the current owner's
 * listing, so the renderer can only ever name a conversation the sidebar would show. */
export function buildSyncedChatHandlers(deps: SyncedChatHandlerDeps) {
  const listed = async (): Promise<{ rows: ChatopsConversation[]; owners: Awaited<ReturnType<typeof deps.owners>> }> => {
    const owners = await deps.owners();
    return { rows: deps.listConversations(deps.dbFile, owners), owners };
  };
  const find = async (surface: unknown, conversationId: unknown) => {
    if (typeof conversationId !== "string" || (surface !== "discord" && surface !== "teams")) throw new Error("malformed synced chat id");
    const { rows, owners } = await listed();
    const row = rows.find((r) => r.surface === surface && r.conversationId === conversationId);
    if (!row) throw new Error("not a synced chat");
    return { row, ownerName: owners.find((o) => o.surface === surface)?.ownerName ?? "the owner" };
  };
  return {
    list: async (): Promise<SyncedChatListing[]> => (await listed()).rows.map((r) => ({
      surface: r.surface, conversationId: r.conversationId, kind: r.kind, title: r.title, updatedAt: r.updatedAt,
      live: deps.liveIds(r.surface).has(r.conversationId), ...(r.liveCli ? { liveCli: r.liveCli } : {}),
      resumable: !!r.liveSessionId, archived: !!r.archivedFrom,
    })),
    get: async (surface: unknown, conversationId: unknown): Promise<SyncedChatRow[]> => {
      const { row, ownerName } = await find(surface, conversationId);
      return mapSyncedTranscript(deps.conversationTurns(deps.dbFile, row.conversationId), row, ownerName);
    },
    send: async (surface: unknown, conversationId: unknown, text: unknown): Promise<SyncedSendResult> => {
      if (typeof text !== "string" || !text.trim()) throw new Error("empty message");
      if (text.length > MAX_DESK_TEXT) return { refused: "too-long" };
      const { row } = await find(surface, conversationId);
      if (row.archivedFrom) return { refused: "no-record" };
      try {
        return await deps.deskTurn(row.surface, row.conversationId, text);
      } catch (err) {
        return { failed: err instanceof Error ? err.message : String(err) };
      }
    },
    /** Continue live: only the conversation id goes to the bot, which re-derives the session. */
    resume: async (surface: unknown, conversationId: unknown): Promise<SyncedSendResult> => {
      const { row } = await find(surface, conversationId);
      if (!row.liveSessionId || row.archivedFrom) return { refused: "no-record" };
      try {
        return await deps.deskResume(row.surface, row.conversationId);
      } catch (err) {
        return { failed: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
