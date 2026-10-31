import { openDb } from "../db.js";
import type { ChatTurn } from "../converse.js";
import type { LiveCli } from "../live-session.js";

export type ChatopsSurface = "discord" | "teams";
export type ConversationKind = "dm" | "thread" | "channel" | "post";

/** Where a card was tapped, as the surface sees it — the catalog's kind and title. */
export interface ConversationPlace {
  kind: ConversationKind;
  /** Discord thread/channel name, Teams conversation name, "DM" for a DM. Display only. */
  title: string;
}

/** One chatops conversation the owner can list and continue from the desktop. */
export interface ChatopsConversation {
  conversationId: string;
  surface: ChatopsSurface;
  kind: ConversationKind;
  title: string;
  /** The platform id the bot saw for the owner here — the id to act as. */
  ownerId: string;
  liveCli?: LiveCli;
  liveSessionId?: string;
  updatedAt: string;
}

/** Write side of `chatops_conversations` for one surface (see
 * .memory/project-chatops-conversation-catalog.md). Only the bot writes it: owner DM turns and
 * owner-started live sessions. */
export class ConversationCatalog {
  constructor(private file: string, private surface: ChatopsSurface, private now: () => Date = () => new Date()) {}

  /** Adds or refreshes a row. `live` set = bind that session (sessionId absent = unset until the
   * CLI reports one); absent = keep the existing binding. */
  upsert(row: {
    conversationId: string; place: ConversationPlace; ownerId: string; ownerAltId?: string;
    live?: { cli: LiveCli; sessionId?: string };
  }): void {
    const db = openDb(this.file);
    const at = this.now().toISOString();
    const live = row.live
      ? ", live_cli = excluded.live_cli, live_session_id = excluded.live_session_id" : "";
    db.prepare(
      "INSERT INTO chatops_conversations (conversation_id, surface, kind, title, owner_id, owner_alt_id, live_cli, live_session_id, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id, surface) DO UPDATE SET " +
        `kind = excluded.kind, title = excluded.title, owner_id = excluded.owner_id, owner_alt_id = excluded.owner_alt_id, updated_at = excluded.updated_at${live}`,
    ).run(
      row.conversationId, this.surface, row.place.kind, row.place.title, row.ownerId, row.ownerAltId ?? null,
      row.live?.cli ?? null, row.live?.sessionId ?? null, at,
    );
  }

  /** This surface's row for a conversation, if catalogued — who it belongs to and where it is. */
  get(conversationId: string): { kind: ConversationKind; title: string; ownerId: string; ownerAltId?: string } | undefined {
    const r = openDb(this.file).prepare(
      "SELECT kind, title, owner_id, owner_alt_id FROM chatops_conversations WHERE conversation_id = ? AND surface = ?",
    ).get(conversationId, this.surface) as { kind: ConversationKind; title: string; owner_id: string; owner_alt_id: string | null } | undefined;
    return r && { kind: r.kind, title: r.title, ownerId: r.owner_id, ...(r.owner_alt_id ? { ownerAltId: r.owner_alt_id } : {}) };
  }

  /** Records the live session id the CLI reported for this conversation's current binding. */
  setLiveSession(conversationId: string, cli: LiveCli, sessionId: string): void {
    openDb(this.file).prepare(
      "UPDATE chatops_conversations SET live_cli = ?, live_session_id = ? WHERE conversation_id = ? AND surface = ?",
    ).run(cli, sessionId, conversationId, this.surface);
  }
}

interface CatalogRow {
  conversation_id: string; surface: ChatopsSurface; kind: ConversationKind; title: string; owner_id: string;
  live_cli: LiveCli | null; live_session_id: string | null; updated_at: string;
}

/** Catalog rows owned by the currently configured owner of each surface, newest first. A row
 * matches by the id the bot saw or (Teams) its AAD alias, so either config form works; rows from
 * a previous owner config stay hidden. An owner with an empty id lists nothing. */
export function listChatopsConversations(file: string, owners: { surface: ChatopsSurface; ownerId: string }[]): ChatopsConversation[] {
  const db = openDb(file);
  const stmt = db.prepare(
    "SELECT conversation_id, surface, kind, title, owner_id, live_cli, live_session_id, updated_at FROM chatops_conversations " +
      "WHERE surface = ? AND (owner_id = ? OR owner_alt_id = ?)",
  );
  const rows = owners.filter((o) => o.ownerId)
    .flatMap((o) => stmt.all(o.surface, o.ownerId, o.ownerId) as unknown as CatalogRow[]);
  return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((r) => ({
    conversationId: r.conversation_id, surface: r.surface, kind: r.kind, title: r.title, ownerId: r.owner_id,
    ...(r.live_cli ? { liveCli: r.live_cli } : {}),
    ...(r.live_session_id ? { liveSessionId: r.live_session_id } : {}),
    updatedAt: r.updated_at,
  }));
}

/** One conversation's stored history (chatops_turns), oldest first. */
export function chatopsConversationTurns(file: string, conversationId: string): ChatTurn[] {
  return (openDb(file).prepare(
    "SELECT role, content FROM chatops_turns WHERE conversation_id = ? ORDER BY seq",
  ).all(conversationId) as unknown as { role: ChatTurn["role"]; content: string }[])
    .map((r) => ({ role: r.role, content: r.content }));
}
