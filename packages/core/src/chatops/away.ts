import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import { enqueueOutbox } from "../outbox.js";
import { formatMuteEnd } from "./chatter.js";

/** The owner's away mode on one chat surface (`chatops_away`, #903). A missing row means off. */
export interface AwayState {
  on: boolean;
  /** Epoch ms away mode was turned on; set only while on. */
  since?: number;
  reason?: string;
}

export interface Away {
  readonly surface: "discord" | "teams";
  get(): AwayState;
  /** On again while already on keeps `since` and replaces the reason. */
  setOn(reason: string | undefined, now: number): void;
  setOff(): void;
  /** Records one owner tag (`chatops_away_captures`). false = this message was already recorded
   * (a redelivery). Throws on a storage failure. */
  capture(c: AwayCapture): boolean;
  /** One away period's captures (by its `since`), oldest first, each with the conversation's
   * known name (chat destinations) when there is one. The summary (#905) is the only reader. */
  captures(awaySince: number | undefined): AwaySummaryRow[];
}

/** A captured row as the summary reads it. */
export interface AwaySummaryRow {
  conversationId: string;
  /** The conversation's alias or platform name, when Bean has seen one. */
  place?: string;
  senderName: string;
  text: string;
  link?: string;
  at: number;
}

/** One message that tagged the owner while away (#904). Owner-only: no tool or command reads it. */
export interface AwayCapture {
  conversationId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  link?: string;
  /** epoch ms */
  at: number;
  /** The away period's start (`AwayState.since`). */
  awaySince?: number;
}

export const AWAY_CAPTURE_TEXT_MAX = 4000;

export const AWAY_REASON_MAX = 200;

export function makeAway(opts: { dbPath: string; surface: "discord" | "teams" }): Away {
  const db: DatabaseSync = openDb(opts.dbPath);
  const { surface } = opts;
  return {
    surface,
    get() {
      const row = db.prepare("SELECT is_on, since, reason FROM chatops_away WHERE surface = ?")
        .get(surface) as { is_on: number; since: number | null; reason: string | null } | undefined;
      if (!row || row.is_on !== 1) return { on: false };
      return { on: true, ...(row.since !== null ? { since: row.since } : {}), ...(row.reason ? { reason: row.reason } : {}) };
    },
    setOn(reason, now) {
      db.prepare(
        `INSERT INTO chatops_away (surface, is_on, since, reason) VALUES (?, 1, ?, ?)
         ON CONFLICT (surface) DO UPDATE SET reason = excluded.reason,
           since = CASE WHEN is_on = 1 THEN since ELSE excluded.since END, is_on = 1`,
      ).run(surface, now, reason ?? null);
    },
    setOff() {
      db.prepare("UPDATE chatops_away SET is_on = 0, since = NULL, reason = NULL WHERE surface = ?").run(surface);
    },
    capture(c) {
      return Number(db.prepare(
        `INSERT OR IGNORE INTO chatops_away_captures
           (surface, conversation_id, message_id, sender_id, sender_name, text, link, at, away_since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        surface, c.conversationId, c.messageId, c.senderId, c.senderName.slice(0, 200),
        c.text.slice(0, AWAY_CAPTURE_TEXT_MAX), c.link ?? null, c.at, c.awaySince ?? null,
      ).changes) > 0;
    },
    captures(awaySince) {
      const rows = db.prepare(
        `SELECT c.conversation_id, c.sender_name, c.text, c.link, c.at, COALESCE(d.alias, d.platform_name) AS place
           FROM chatops_away_captures c
           LEFT JOIN chat_destinations d ON d.surface = c.surface AND d.conversation_id = c.conversation_id
          WHERE c.surface = ? AND c.away_since IS ?
          ORDER BY c.at, c.rowid`,
      ).all(surface, awaySince ?? null) as unknown as {
        conversation_id: string; sender_name: string; text: string; link: string | null; at: number; place: string | null;
      }[];
      return rows.map((r) => ({
        conversationId: r.conversation_id, senderName: r.sender_name, text: r.text, at: r.at,
        ...(r.place ? { place: r.place } : {}), ...(r.link ? { link: r.link } : {}),
      }));
    },
  };
}

export type AwayCommand = { kind: "on"; reason?: string } | { kind: "off" } | { kind: "status" };

/** `away on [reason]`, `away off`, `away status` — the whole message, optional leading slash.
 * The reason is literal text: whitespace collapsed to one line, capped at AWAY_REASON_MAX. */
export function parseAwayCommand(text: string): AwayCommand | undefined {
  const m = /^\/*away\s+(on|off|status)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase() as AwayCommand["kind"];
  const rest = (m[2] ?? "").replace(/\s+/g, " ").trim();
  if (kind !== "on") return rest ? undefined : { kind };
  return rest ? { kind, reason: rest.slice(0, AWAY_REASON_MAX).trim() } : { kind };
}

const label = (surface: Away["surface"]): string => surface === "teams" ? "Teams" : "Discord";

/** Every refused use (not the owner, or not their real DM) hears this one line — never the state. */
export const awayRefusal = (ownerName: string): string =>
  `Only ${ownerName} can use \`away\`, and only in a direct message with me.`;

/** Runs an owner-DM `away` command and returns the one-line answer. */
export function runAwayCommand(away: Away, c: AwayCommand, now: number): string {
  const where = label(away.surface);
  const before = away.get();
  if (c.kind === "status") {
    if (!before.on) return `Away mode is off for ${where}.`;
    return `Away mode is on for ${where}${before.since !== undefined ? ` since ${formatMuteEnd(before.since)}` : ""}` +
      `${before.reason ? ` (reason: ${before.reason})` : ""}.`;
  }
  if (c.kind === "off") return closeAway(away) ?? `Away mode was already off for ${where}.`;
  away.setOn(c.reason, now);
  return `Away mode is ${before.on ? "still " : ""}on for ${where}${c.reason ? ` (reason: ${c.reason})` : ""}. \`away off\` ends it.`;
}

/** Appended to the owner's own answers on a surface where away mode is on. */
export const awayReminder = (away: Away): string =>
  `(Away mode is on for ${label(away.surface)} — \`away off\` in our DM ends it.)`;

/** The fixed line a tagger hears while the owner is away (#904). Code-built; `recorded` false (the
 * row failed to save) drops the claim that it was recorded. */
export const awayLine = (ownerName: string, reason: string | undefined, recorded: boolean): string =>
  `${ownerName} is away${reason ? ` (${reason})` : ""}.${recorded ? ` I've recorded your message for when ${ownerName} is back.` : ""}`;

export const AWAY_SUMMARY_MAX = 20;
const QUOTE_MAX = 160;

// Captured text and names are other people's words: one line (no newline can start a fake header
// or entry), clipped. Quotes go in an inline code span (no markdown, mentions or links render), so
// a backtick inside becomes a plain quote mark; names lose markdown characters.
const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const quote = (s: string): string => `\`${oneLine(s.replace(/`/g, "'"), QUOTE_MAX) || "(no text)"}\``;
const plain = (s: string, max: number): string => oneLine(s.replace(/[\\`*_~|<>#[\]()]/g, ""), max);

/** The return summary of one away period (#905): pure, no model call. Entries grouped by
 * conversation (in order of first tag), oldest first, at most AWAY_SUMMARY_MAX, then "and N more". */
export function awaySummary(surface: Away["surface"], since: number | undefined, rows: readonly AwaySummaryRow[]): string {
  const where = label(surface);
  if (!rows.length) return `Away mode is off for ${where}. Nobody tagged you while you were away.`;
  const shown = rows.slice(0, AWAY_SUMMARY_MAX);
  const groups = new Map<string, AwaySummaryRow[]>();
  for (const r of shown) groups.set(r.conversationId, [...(groups.get(r.conversationId) ?? []), r]);
  const convs = new Set(rows.map((r) => r.conversationId)).size;
  const lines = [
    `Away mode is off for ${where}. While you were away${since !== undefined ? ` (since ${formatMuteEnd(since)})` : ""}, ` +
      `you were tagged ${rows.length} time${rows.length === 1 ? "" : "s"} in ${convs} conversation${convs === 1 ? "" : "s"}:`,
  ];
  for (const group of groups.values()) {
    const place = group[0]?.place ? plain(group[0].place, 80) : "";
    lines.push("", `**${place || "A conversation"}**`);
    for (const r of group) lines.push(`- ${plain(r.senderName, 60) || "Someone"}: ${quote(r.text)}${r.link ? ` ${r.link}` : ""}`);
  }
  if (rows.length > shown.length) lines.push("", `…and ${rows.length - shown.length} more.`);
  return lines.join("\n");
}

/** Ends the away period and returns its summary; undefined when away mode was already off. The
 * rows are read and the state cleared with no await between, so no tag lands in neither. */
export function closeAway(away: Away): string | undefined {
  const state = away.get();
  if (!state.on) return undefined;
  const rows = away.captures(state.since);
  away.setOff();
  return awaySummary(away.surface, state.since, rows);
}

/** Away mode ended anywhere but the owner's DM: close the period and queue the summary as a
 * channel-less, user-less outbox message — the owner's own DM only (Discord: `ownerId`; Teams: the
 * owner's personal conversation). Each drain retries that DM, then gives up without a notice; it
 * never falls back to a channel. false = away mode was already off (nothing queued). */
export async function closeAwayToOwnerDm(away: Away, outboxDir: string, newId: () => string): Promise<boolean> {
  const body = closeAway(away);
  if (body === undefined) return false;
  await enqueueOutbox(outboxDir, { transport: away.surface, body }, newId);
  return true;
}
